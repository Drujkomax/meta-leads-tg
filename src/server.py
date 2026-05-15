from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, Request, Response

from .lib import (
    close_http_client,
    env,
    format_lead_message,
    graph_get,
    send_telegram,
    send_telegram_safe,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("meta-leads-tg")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await close_http_client()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health() -> Response:
    return Response("ok", media_type="text/plain; charset=utf-8")


@app.get("/webhook")
async def verify_webhook(request: Request) -> Response:
    q = request.query_params
    if (
        q.get("hub.mode") == "subscribe"
        and q.get("hub.verify_token") == env.META_VERIFY_TOKEN
    ):
        return Response(q.get("hub.challenge", ""), media_type="text/plain; charset=utf-8")
    return Response("forbidden", status_code=403, media_type="text/plain; charset=utf-8")


@app.post("/webhook")
async def handle_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
) -> Response:
    raw = await request.body()

    if not _verify_signature(raw, x_hub_signature_256, env.META_APP_SECRET):
        log.info("signature verification failed")
        return Response("forbidden", status_code=403, media_type="text/plain; charset=utf-8")

    try:
        payload = await request.json()
    except Exception:
        return Response("bad json", status_code=400, media_type="text/plain; charset=utf-8")

    asyncio.create_task(_safe_process(payload))
    return Response("ok", media_type="text/plain; charset=utf-8")


def _verify_signature(raw: bytes, header: str | None, secret: str | None) -> bool:
    if not header or not header.startswith("sha256=") or not secret:
        return False
    expected = header[7:]
    computed = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(computed, expected)


async def _safe_process(payload: dict[str, Any]) -> None:
    try:
        await _process_payload(payload)
    except Exception as err:
        log.exception("processPayload failed: %s", err)


async def _process_payload(payload: dict[str, Any]) -> None:
    if payload.get("object") != "page":
        return
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            if change.get("field") != "leadgen":
                continue
            value = change.get("value") or {}
            try:
                await _process_lead(value)
            except Exception as err:
                log.exception("processLead failed: %s", err)
                await send_telegram_safe(
                    f"⚠️ Ошибка при обработке лида {value.get('leadgen_id')}: {str(err)[:300]}"
                )


async def _process_lead(value: dict[str, Any]) -> None:
    leadgen_id = value.get("leadgen_id")
    if not leadgen_id:
        raise RuntimeError("no leadgen_id in payload")

    lead = await graph_get(
        f"/{leadgen_id}",
        {
            "fields": (
                "id,created_time,ad_id,ad_name,adset_id,adset_name,"
                "campaign_id,campaign_name,form_id,field_data,is_organic,platform"
            ),
        },
    )

    form: dict[str, Any] | None = None
    if lead.get("form_id"):
        try:
            form = await graph_get(f"/{lead['form_id']}", {"fields": "name,questions"})
        except Exception as err:
            log.warning("form fetch failed: %s", err)

    message = format_lead_message(lead, form)
    results = await asyncio.gather(
        send_telegram(env.TELEGRAM_PERSONAL_CHAT_ID, message),
        send_telegram(env.TELEGRAM_GROUP_CHAT_ID, message),
        return_exceptions=True,
    )
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            log.warning("telegram send #%d failed: %s", i, r)
