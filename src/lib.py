from __future__ import annotations

import asyncio
import html
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import httpx

GRAPH_API = "https://graph.facebook.com/v22.0"

log = logging.getLogger("meta-leads-tg")


class Env:
    META_VERIFY_TOKEN = os.environ.get("META_VERIFY_TOKEN")
    META_APP_SECRET = os.environ.get("META_APP_SECRET")
    META_PAGE_ACCESS_TOKEN = os.environ.get("META_PAGE_ACCESS_TOKEN")
    TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
    TELEGRAM_PERSONAL_CHAT_ID = os.environ.get("TELEGRAM_PERSONAL_CHAT_ID")
    TELEGRAM_GROUP_CHAT_ID = os.environ.get("TELEGRAM_GROUP_CHAT_ID")


env = Env()

_http: httpx.AsyncClient | None = None


def http_client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=30.0)
    return _http


async def close_http_client() -> None:
    global _http
    if _http is not None:
        await _http.aclose()
        _http = None


async def graph_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    p = dict(params or {})
    p["access_token"] = env.META_PAGE_ACCESS_TOKEN
    return await graph_get_url(GRAPH_API + path, p)


async def graph_get_url(url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    res = await http_client().get(url, params=params)
    if res.status_code >= 400:
        raise RuntimeError(f"graph {res.status_code}: {res.text[:300]}")
    return res.json()


def escape_html(s: Any) -> str:
    return html.escape(str(s), quote=False)


def build_question_map(form: dict[str, Any] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for q in (form or {}).get("questions") or []:
        key = q.get("key")
        if key:
            out[key] = q.get("label") or key
    return out


def _humanize(name: str) -> str:
    s = name.replace("_", " ")
    return s[:1].upper() + s[1:] if s else s


_MONTHS_RU = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def format_date_ru(iso: str) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(ZoneInfo("Asia/Tashkent"))
    return f"{local.day} {_MONTHS_RU[local.month - 1]} {local.year} г., {local:%H:%M}"


def format_lead_message(lead: dict[str, Any], form: dict[str, Any] | None) -> str:
    form_name = (form or {}).get("name") or lead.get("form_id")
    qmap = build_question_map(form)

    lines: list[str] = []
    if form_name:
        lines.append(f"📋 <b>{escape_html(form_name)}</b>")
    if lead.get("created_time"):
        lines.append(f"📅 {format_date_ru(lead['created_time'])}")
    lines.append("")

    for f in lead.get("field_data") or []:
        values: list[str] = [
            str(v) for v in (f.get("values") or [])
            if v is not None and str(v).strip() != ""
        ]
        if not values:
            continue
        label = qmap.get(f.get("name") or "") or _humanize(f.get("name") or "")
        lines.append(f"<b>{escape_html(label)}</b>")
        lines.append(", ".join(escape_html(v) for v in values))
        lines.append("")

    chain_parts: Iterable[str] = (
        lead.get("campaign_name"),
        lead.get("adset_name"),
        lead.get("ad_name"),
    )
    chain = " → ".join(escape_html(p) for p in chain_parts if p)
    if chain:
        lines.append("—")
        lines.append(f"📣 {chain}")

    return "\n".join(lines).rstrip()


async def send_telegram(chat_id: str | None, text: str) -> None:
    if not chat_id:
        return
    url = f"https://api.telegram.org/bot{env.TELEGRAM_BOT_TOKEN}/sendMessage"
    res = await http_client().post(
        url,
        json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    if res.status_code >= 400:
        raise RuntimeError(f"telegram {chat_id} {res.status_code}: {res.text[:300]}")


async def send_telegram_safe(text: str) -> None:
    try:
        await send_telegram(env.TELEGRAM_PERSONAL_CHAT_ID, text)
    except Exception as err:
        log.warning("alert send failed: %s", err)


_RETRY_AFTER_RE = re.compile(r'"retry_after"\s*:\s*(\d+)')


async def send_telegram_with_retry(
    chat_id: str | None, text: str, *, max_retries: int = 4
) -> None:
    for attempt in range(max_retries + 1):
        try:
            await send_telegram(chat_id, text)
            return
        except Exception as err:
            msg = str(err)
            m = _RETRY_AFTER_RE.search(msg)
            if m:
                wait = (int(m.group(1)) + 1)
                log.info("rate-limited on %s, waiting %ss", chat_id, wait)
                await asyncio.sleep(wait)
                continue
            if attempt == max_retries:
                raise
            await asyncio.sleep(1.5 * (attempt + 1))
