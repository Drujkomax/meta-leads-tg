from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

from .lib import (
    GRAPH_API,
    close_http_client,
    env,
    format_lead_message,
    graph_get_url,
    send_telegram_with_retry,
)

LEAD_FIELDS = (
    "id,created_time,ad_id,ad_name,adset_id,adset_name,"
    "campaign_id,campaign_name,form_id,field_data,is_organic,platform"
)

log = logging.getLogger("meta-leads-tg.backfill")


def _to_unix(value: str) -> int:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


async def list_all_forms() -> list[dict[str, Any]]:
    params = {
        "fields": "id,name,status,questions",
        "limit": "100",
        "access_token": env.META_PAGE_ACCESS_TOKEN,
    }
    url = f"{GRAPH_API}/me/leadgen_forms"
    forms: list[dict[str, Any]] = []
    next_url: str | None = url
    next_params: dict[str, Any] | None = params
    while next_url:
        data = await graph_get_url(next_url, next_params)
        forms.extend(data.get("data") or [])
        next_url = (data.get("paging") or {}).get("next")
        next_params = None
    return forms


async def list_leads_for_form(
    form_id: str, since_unix: int, until_unix: int | None
) -> list[dict[str, Any]]:
    filtering = [{"field": "time_created", "operator": "GREATER_THAN", "value": since_unix}]
    if until_unix:
        filtering.append({"field": "time_created", "operator": "LESS_THAN", "value": until_unix})

    params = {
        "fields": LEAD_FIELDS,
        "filtering": json.dumps(filtering),
        "limit": "100",
        "access_token": env.META_PAGE_ACCESS_TOKEN,
    }
    url = f"{GRAPH_API}/{form_id}/leads"
    leads: list[dict[str, Any]] = []
    next_url: str | None = url
    next_params: dict[str, Any] | None = params
    while next_url:
        data = await graph_get_url(next_url, next_params)
        leads.extend(data.get("data") or [])
        next_url = (data.get("paging") or {}).get("next")
        next_params = None
    return leads


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill historical leads to Telegram")
    p.add_argument("--since", help="ISO date/time, inclusive lower bound")
    p.add_argument("--until", help="ISO date/time, exclusive upper bound")
    p.add_argument(
        "--days",
        type=int,
        default=int(os.environ.get("BACKFILL_DAYS", "7")),
        help="Lookback window in days (ignored if --since is set)",
    )
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--delay-ms",
        type=int,
        default=int(os.environ.get("BACKFILL_DELAY_MS", "4000")),
        help="Delay between Telegram sends (ms)",
    )
    return p.parse_args()


async def _main_async() -> int:
    args = _parse_args()

    if not env.META_PAGE_ACCESS_TOKEN:
        raise RuntimeError("META_PAGE_ACCESS_TOKEN missing")
    if not env.TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN missing")
    if not env.TELEGRAM_PERSONAL_CHAT_ID and not env.TELEGRAM_GROUP_CHAT_ID:
        raise RuntimeError("no telegram chat ids configured")

    if args.since:
        since_unix = _to_unix(args.since)
        days_label: int | None = None
    else:
        since_unix = int(datetime.now(timezone.utc).timestamp()) - args.days * 86400
        days_label = args.days

    until_unix = _to_unix(args.until) if args.until else None
    delay = args.delay_ms / 1000.0

    since_iso = datetime.fromtimestamp(since_unix, tz=timezone.utc).isoformat()
    until_iso = (
        datetime.fromtimestamp(until_unix, tz=timezone.utc).isoformat() if until_unix else "now"
    )
    days_suffix = f" (last {days_label}d)" if days_label else ""
    log.info("backfill window: %s → %s%s", since_iso, until_iso, days_suffix)
    log.info("dry_run=%s, delay=%sms", args.dry_run, args.delay_ms)

    log.info("listing forms…")
    forms = await list_all_forms()
    log.info("found %d forms", len(forms))

    all_items: list[dict[str, Any]] = []
    for f in forms:
        try:
            leads = await list_leads_for_form(f["id"], since_unix, until_unix)
            for l in leads:
                all_items.append({"lead": l, "form": f})
            log.info('  form %s "%s" → %d leads', f.get("id"), f.get("name"), len(leads))
        except Exception as err:
            log.warning('  form %s "%s" failed: %s', f.get("id"), f.get("name"), err)

    all_items.sort(key=lambda item: item["lead"].get("created_time") or "")
    log.info("total leads in window: %d", len(all_items))

    if not all_items:
        log.info("nothing to send")
        return 0

    if args.dry_run:
        for item in all_items:
            print("---")
            print(format_lead_message(item["lead"], item["form"]))
        return 0

    sent = failed = 0
    for i, item in enumerate(all_items):
        message = format_lead_message(item["lead"], item["form"])
        try:
            if env.TELEGRAM_PERSONAL_CHAT_ID:
                await send_telegram_with_retry(env.TELEGRAM_PERSONAL_CHAT_ID, message)
                await asyncio.sleep(delay)
            if env.TELEGRAM_GROUP_CHAT_ID:
                await send_telegram_with_retry(env.TELEGRAM_GROUP_CHAT_ID, message)
                await asyncio.sleep(delay)
            sent += 1
            if (i + 1) % 10 == 0:
                log.info("  progress: %d/%d sent", i + 1, len(all_items))
        except Exception as err:
            failed += 1
            log.warning("lead %s send failed: %s", item["lead"].get("id"), err)
            await asyncio.sleep(delay * 2)

    log.info("done. sent=%d, failed=%d", sent, failed)
    return 0


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        code = asyncio.run(_wrap())
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)


async def _wrap() -> int:
    try:
        return await _main_async()
    finally:
        await close_http_client()


if __name__ == "__main__":
    main()
