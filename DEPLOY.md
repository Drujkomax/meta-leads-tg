# meta-leads-tg — деплой

Принимает webhook от Meta (Facebook Leads Ads) и пересылает новые лиды в Telegram-группу. Python + FastAPI + httpx.

## Требования

- **Python 3.12+**
- HTTPS-эндпоинт (Meta не вызовет HTTP). Любая платформа с авто-TLS (Railway/Render/Fly) или свой VPS + Caddy/nginx + Let's Encrypt
- Открытый публичный домен — Meta должна достучаться

## Переменные окружения

Положи в `.env` рядом с `requirements.txt` (значения уже подставлены — спроси у заказчика, если файла нет):

```
META_APP_SECRET=...                  # для проверки подписи x-hub-signature-256
META_VERIFY_TOKEN=itssecret123       # для GET /webhook (Meta verify)
META_PAGE_ACCESS_TOKEN=...           # бессрочный Page Token, не истекает
TELEGRAM_BOT_TOKEN=...
TELEGRAM_GROUP_CHAT_ID=-1003604339693  # ID группы "MSC лидлар"
PORT=3000                             # опционально, платформы обычно сами выставляют $PORT
```

## Запуск

**Локально / на VPS:**
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
set -a && . ./.env && set +a
uvicorn src.server:app --host 0.0.0.0 --port "${PORT:-3000}"
```

**На платформе** (Railway/Render/Fly) переменные прокидываются через UI/env vars. Команда запуска:
```bash
uvicorn src.server:app --host 0.0.0.0 --port $PORT
```

**Docker:**
```bash
docker compose up -d --build
```

**systemd unit** (если ставишь на свой Linux-VPS):
```ini
# /etc/systemd/system/meta-leads-tg.service
[Unit]
Description=meta-leads-tg
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/meta-leads-tg
EnvironmentFile=/opt/meta-leads-tg/.env
ExecStart=/opt/meta-leads-tg/.venv/bin/uvicorn src.server:app --host 0.0.0.0 --port 3000
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```
Включить: `sudo systemctl enable --now meta-leads-tg`.

## Эндпоинты

| Метод | Путь | Назначение |
|-------|------|------------|
| GET   | `/health`  | healthcheck, всегда `200 ok` |
| GET   | `/webhook` | верификация Meta (`hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`) |
| POST  | `/webhook` | приём leadgen-событий (с проверкой `x-hub-signature-256`) |

## После деплоя

1. **Обнови callback URL в Meta App Dashboard** → App Dashboard → Webhooks → Page → Edit Subscription:
   - Callback URL: `https://<твой-домен>/webhook`
   - Verify Token: значение из `META_VERIFY_TOKEN` (`itssecret123`)
   - Подпиши на field `leadgen` (если ещё не подписан)
2. Проверь, что Page **Med Service Centre** подписана на приложение `leadsresender` (App Dashboard → Webhooks → Page subscriptions).
3. Тест: отправь тестовый лид через **Lead Ads Testing Tool**: https://developers.facebook.com/tools/lead-ads-testing — должен прилететь в группу "MSC лидлар".

## Бэкфилл (досыл прошлых лидов)

Если надо ещё раз залить историю в группу:
```bash
python -m src.backfill                       # последние 7 дней, реальная отправка
python -m src.backfill --dry-run             # последние 7 дней, только в консоль
python -m src.backfill --days 3
python -m src.backfill --since 2026-05-01 --until 2026-05-05
```

## Структура

```
src/
  server.py     # webhook-сервер (FastAPI)
  backfill.py   # CLI для досыла истории
  lib.py        # общий код: Graph API, форматирование, Telegram-клиент
.env            # секреты (НЕ коммитить, в .gitignore)
requirements.txt
```

## Ротация Telegram-группы

Если меняется группа назначения:
1. Добавь бота в новую группу (как админа, чтобы мог писать)
2. Напиши там любое сообщение
3. `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → найди `chat.id` (отрицательное число)
4. Подмени `TELEGRAM_GROUP_CHAT_ID` в `.env` / env vars
5. Рестарт сервиса

## Если webhook молчит

- Логи сервиса: ищи `signature verification failed` (неверный `META_APP_SECRET`) или `graph 401` (умер токен — теоретически не должен, он бессрочный, но если страницу отвязали от приложения, токен инвалидируется).
- Curl своими руками `GET /webhook?hub.mode=subscribe&hub.verify_token=itssecret123&hub.challenge=test` должен вернуть `test`.
- Meta App Dashboard → Webhooks показывает статус последних доставок и ошибки.
