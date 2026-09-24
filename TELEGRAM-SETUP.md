# 📡 TELEGRAM-SETUP.md — free 24/7 eyes on SecondShift (5 minutes, $0)

A Telegram bot is the only free notification channel that needs **no server, no card, no email verification** — and it works from your phone, which is where you'll be when something breaks. Your server gets a watchdog: it messages **you** the moment a route 5xxs, a crash happens, or the data store drifts — and you can text it back `/status` to see live business numbers.

---

## 1 · Create the bot (2 min)

1. Open Telegram → search **@BotFather** (verified blue check) → send `/newbot`.
2. It asks for a **name** → e.g. `SecondShift Monitor`.
3. It asks for a **username** → must end in `bot` → e.g. `secondshift_ops_bot`.
4. BotFather replies with a **token** like `7123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr5K-3c` — copy it. **This is the bot's password; never commit it** (it goes in `.env`, which is already gitignored, or Render env vars).

## 2 · Get your chat id (1 min)

Telegram bots can only message people who messaged them first, so:

1. Open your new bot (search its username) → press **START** (or send any message, e.g. `hi`).
2. In a browser, open (paste your real token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. In the JSON, find `"chat":{"id":123456789,...}` — that number is **your chat id**. (It stays the same forever.)

## 3 · Configure (1 min)

**Locally** — add to `automation-lab/.env`:
```
TELEGRAM_BOT_TOKEN=7123456789:AAEhBOweik...
TELEGRAM_CHAT_ID=123456789
```

**On Render** — Dashboard → your service → **Environment** → add the same two keys → **Save Changes** (redeploys).

Restart/redeploy → the boot log says `[monitor] ✔ Telegram monitor live`. If you skip this config, the site runs **exactly as before** — the monitor is a complete no-op until both keys exist.

## 4 · Test it (1 min)

1. Send your bot `/status` → it replies with live counts (leads, clients, MRR, calls, appointments, invoices) straight from the data store.
2. `/health` → probes every critical route + the data file right now and reports ✅/❌ per line.
3. `/help` → command menu.

Automatic alerts you'll receive without doing anything:
- 💥 **`uncaughtException` / `unhandledRejection`** — a crash just happened (deduped per error, 5-min window)
- 🚨 **5xx** — any route returned a server error (deduped per route, shows "N × in the last hour")
- 👁 **Watchdog DOWN / ✅ Recovered** — every 5 minutes the monitor probes `/`, `/healthz`, the automations + stats APIs, `/voice.html`, the data store, and cloud sync; new failures alert immediately, recovery sends one notice
- Anti-spam: max 20 messages/minute, hard-capped, so a meltdown can't flood you (or Telegram)

## 5 · Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` in logs | Token wrong/copy-pasted with a space — re-copy from BotFather |
| `/status` never replies | You never pressed START on the bot, or the chat id in `TELEGRAM_CHAT_ID` isn't yours |
| Bot silent but site works | Check Render **Logs** → `Logs` show `[monitor]` lines and any `telegram sendMessage → 4xx` error |
| Multiple people get replies | Impossible — commands only work from your chat id; strangers get silence |
| Want a second viewer (e.g. a partner) | They press START on the bot, you append their chat id — currently the code reads one `TELEGRAM_CHAT_ID`; ask me to add a list |

## 6 · What it costs

**$0.** Telegram's Bot API is free with no meaningful limits at this scale. Compare: UptimeRobot-style SaaS monitoring starts at ~$7–20/mo and doesn't give you `/status` with *your* business numbers.

## 7 · How it's built (for future-you)

- `telegram-monitor.js` — the whole monitor. **No-op unless both env vars exist**; every failure inside it is caught, timed, and rate-limited, so it can never take the site down. Follows the same activation pattern as `cloud-store.js`.
- `server.js` — wires it: a 5xx tap middleware, crash hooks, watchdog probes, and the store-backed commands.
- `scripts/telegram-e2e.js` — 21-check E2E against a mock Bot API (`node scripts/telegram-e2e.js` → `TELEGRAM_E2E_PASS`). Covers: no-env zero-network mode, delivery, dedup, 5xx + crash alerts, watchdog DOWN/recovery, commands with real store data, dead-token resilience.
