# The Voice × Dograh — free self-hosted voice line

The tester on `/voice.html` has **three ways to talk**:

| Line | Brain | Cost | Runs on |
|------|-------|------|---------|
| Free mic (default) | this server | free | Render + browser Web Speech + Kokoro |
| **Dograh (free line)** | Dograh agent (own prompt) | **free, unlimited** | **this PC, Docker** |
| Vapi (pro line) | this server via custom-LLM bridge | Vapi credits/min | Vapi cloud |

Dograh replaces the per-minute billing model entirely: the platform is open
source (BSD-2, `github.com/dograh-hq/dograh`) and self-hosted, so test calls
are unlimited and free. The agent's persona/prompt lives in the Dograh UI,
not in this repo.

## Layout

- **Stack location:** `D:\my LLM\.n8n-files\website\secondshift\dograh\`
  (`docker-compose.yaml` + generated `.env` + `scripts/` + `deploy/`)
- **UI:** http://localhost:3010 (login: the account you created on first run)
- **Agent:** "SecondShift automation service tester - inbound" (workflow 1)
- **Embed token:** `public/dograh-endpoints.json` (tracked) / `DOGRAH_EMBED_TOKEN` in `.env`
- **Site integration:** `/api/dograh/config` resolves endpoints **from
  `public/dograh-endpoints.json` first, then `.env`** (local override wins).
  The JSON file is tracked in git so Render deploys the current URLs; the
  repo is public and the token is public-by-design (it ships in the page DOM).
  `scripts/dograh-watchdog.js` keeps the file fresh — see below.

## Local quirks fixed in this install (don't lose these)

1. **MinIO image**: `quay.io/minio/minio` returns **401 to anonymous pulls**
   from this network (MinIO walled off their quay images). The compose file
   pins `cgr.dev/chainguard/minio:latest` with `user: "0"` instead.
   Distroless ⇒ **no in-container healthcheck** ⇒ `api` depends on it with
   `service_started` (not `service_healthy`). Reverting either edit breaks
   `docker compose up` with "dependency failed to start".
2. **`local-turn` profile needs the repo's `scripts/` + `deploy/` dirs**
   (the quick-start script only downloads compose files). They were extracted
   from the repo tarball into the stack folder. `dograh-init` renders coturn's
   config from them.
3. **TURN is mandatory for calls to work**: Docker-NAT ICE candidates are
   unreachable from the browser without it. `.env` has
   `ENABLE_COTURN=true`, `TURN_SECRET=…` and **`TURN_HOST=192.168.1.76`**
   (this PC's LAN IP — both the browser and the api container can reach
   coturn there). If your Wi-Fi IP changes, update TURN_HOST.
4. `ENABLE_TELEMETRY=false` (was set at install).
5. **Tunnels run `--protocol http2`** (recreated 2026-10-01, same names/ports).
   Default QUIC (UDP) kept flapping on this NAT — URLs churned several times
   an hour. `docker restart` preserves the pin, so watchdog heals stay
   http2 too. The api tunnel also supports a permanent named tunnel: set
   `CLOUDFLARE_TUNNEL_TOKEN` + `CLOUDFLARED_COMMAND="tunnel run"` in
   `dograh/.env` (see "Never unreachable" below).

## Daily use

```bash
# start everything (Docker Desktop must be running)
cd "/d/my LLM/.n8n-files/website/secondshift/dograh"
docker compose --profile tunnel --profile local-turn up -d

# stop
docker compose --profile tunnel --profile local-turn down
```

Test locally: open http://localhost:4000/voice.html → green **Talk on the
free line** button. From the phone on the same Wi-Fi:
`http://192.168.1.76:4000/voice.html`.

## Indian + international callers (the free line)

The agent you demo is tuned for **both markets** — Indian accents and
international English — with one tool: `scripts/dograh-tune.js`.

```bash
node scripts/dograh-tune.js show                            # what the agent is set to now
node scripts/dograh-tune.js language india --apply          # en-IN — Indian English
node scripts/dograh-tune.js language international --apply  # en — accent-agnostic English
node scripts/dograh-tune.js language multilingual --apply   # multi — auto-detect (en + hi + 8)
node scripts/dograh-tune.js prompts --apply                 # India + international behaviour
node scripts/dograh-tune.js restore                         # undo the last change
```

- **Speech recognition (accent):** the STT language is the knob that decides how
  well an accent is *heard*. `en-IN` is Deepgram's Indian-English model — the best
  match for Indian accents and Hinglish. `en` is accent-agnostic English for
  international callers. `multi` auto-detects only **de, en, es, fr, hi, it, ja,
  nl, pt, ru** (it is not the full 81-language list offered for explicit picks).
- **Behaviour prompts:** `prompts --apply` appends an `## ACCENT & MARKET HANDLING`
  section to the global prompt: mirror the caller's language (English / Hindi /
  Hinglish), treat Indian-English phrasing (“kindly”, “day after tomorrow”,
  “4 o'clock”) as normal speech, read back 10-digit / +91 numbers, understand
  lakh/crore, and keep a neutral English tone for callers from outside India.
  It is idempotent — re-running never stacks sections.
- **Voice:** stays on Dograh's managed `default`. Managed mode allows a custom
  voice id (Settings → voice), so an Indian-English voice id can be dropped in
  later if you find one you like.
- **Safety:** every write is backed up first to `dograh-tune.backup.json`
  (gitignored), the run is a dry-run unless you pass `--apply`, and the API
  container is restarted afterwards so the agent reloads (a few seconds).
  The tuner edits only two rows: `organization_configurations`
  (`MODEL_CONFIGURATION_V2`) and `workflow_definitions` (`workflow_json`);
  `restore` puts both back.

**Demo cheat sheet:** Indian client → `language india` · international client →
`language international` · mixed or unknown → `language multilingual`.

## Tunnel URLs self-heal — the watchdog

The public URLs are trycloudflare **quick tunnels** (ephemeral): they rotate
whenever the tunnels restart, which used to break the live line until someone
manually refreshed `.env`. **`scripts/dograh-watchdog.js` now automates it**:

- Windows scheduled task **`DograhTunnelWatchdog`** runs it every 5 minutes
  (`schtasks //Query //TN DograhTunnelWatchdog`; logs → `watchdog.log`).
- Each run health-checks the API tunnel URL from `public/dograh-endpoints.json`.
- If dead (or cloudflared is stuck retrying a dead registration — the
  "Tunnel not found" limbo): restarts `cloudflared-tunnel` + `dograh-ui-tunnel`,
  reads the new URLs from the container logs, rewrites the JSON file **and
  `.env`**, then commits + pushes — Render auto-deploys the fresh endpoints
  within ~1 min. Commits only happen when URLs actually changed (health
  flaps are no-ops). Tested: planted a dead URL → watchdog detected it,
  healed, pushed (commit `471e1c5`). Healthy runs are no-ops (no commits).
- Task rebuilt 2026-09-27 (`scripts/fix-watchdog-task.ps1`): repetition is
  indefinite (the old task silently stopped repeating each day at 02:53 —
  that 13-hour dark window let a dead tunnel sit for 21 h), runs on battery,
  wakes to run, and logs via `scripts/dograh-watchdog.cmd` → `watchdog.log`.

Run it manually any time:

```bash
cd "/d/my LLM/.n8n-files/website/secondshift" && node scripts/dograh-watchdog.js
```

### Telegram heal alerts (your phone knows what the PC fixed)

The watchdog sends you a Telegram message whenever it repairs the free line:

- **🔄 self-healed (rotation)** — the quick tunnel re-registered under a new
  URL on its own; the watchdog adopted it and the site is already serving it.
- **🛠 self-healed (recreated)** — the tunnel was dead; containers were
  recreated, new URLs adopted, push done.
- **⚠️ still down** — a run could not get new URLs; retries continue every
  5 min automatically.
- **🎉 permanent cutover** — one-time: the watchdog switches the endpoints to
  `voice.secondshift.space` the moment your Cloudflare nameservers go live.

Setup (PC `.env`, picked up on the watchdog's next 5-min run — no restart
needed; the scheduler never has the values cached):

```ini
WATCHDOG_TELEGRAM_BOT_TOKEN=<same token as the Render bot>
WATCHDOG_TELEGRAM_CHAT_ID=<your chat id>
```

The same token is safe: the watchdog only **sends** one-shot messages and
never polls, so it can't fight the Render bot for updates. Anti-spam: heals
cooldown 10 min, still-down warnings 30 min (`watchdog.alerts.json`). Without
creds the watchdog logs `telegram heal alerts not configured` and carries on.

## Never unreachable — the five layers

1. **Self-heal (automatic, ≤5 min):** the scheduler task runs the watchdog
   every 5 minutes around the clock; it recycles dead/limbo tunnels and
   pushes fresh URLs that Render deploys in ~1 min. Downtime ceiling ≈ 6 min.
   **Hang-proof (2026-10-02):** the 01:03 outage happened because the
   watchdog's `execSync` froze inside a Windows pipe while docker restarted
   containers, and the task's "ignore new instances" policy then blocked
   every later run. Fixed: shell calls are now spawn-with-killTree (a stalled
   docker can never wedge a run), dead runs recreate tunnels instead of
   restarting them (restarts can keep the dead registration), self-rotated
   quick-tunnel URLs are adopted from container logs without any recycle,
   and the task now uses **Queue** (a blocked run queues the next one
   instead of skipping it) with the same 10-min time limit.
   **New-URL grace:** a just-recreated tunnel answers 530 for ~2 min while
   Cloudflare's edge propagates; the watchdog waits (bounded) before
   committing URLs and treats a fresh edge registration as "propagating",
   not "dead" — no more URL churn during heal windows.
2. **In-server sentinel (PC only, automatic):** the site server probes the
   free line in every watchdog cycle. If it's down AND the scheduler
   heartbeat (`watchdog.heartbeat`, touched by every watchdog exit) is
   stale >8 min, the server spawns the tunnel watchdog itself (fire-and-
   forget, rate-capped 1×/20 min) and sends a 🛟 Telegram alert — so a wedged
   scheduler can no longer leave the line down.
3. **Server-side eyes (automatic alert):** any Dograh outage gets a 🚨 alert
   with a **🔧 Fix: fix-dograh-tunnels** button; `/diagnose` lists it too,
   and `/health` shows a `dograh free line` row. One tap spawns the repair
   and reports the outcome as a follow-up message.
4. **Permanent URLs (SET UP 2026-10-01 — one manual step left):** the named
   tunnel **secondshift-dograh** (id `59db6928-a6a1-465d-9ed9-55b81bd81328`)
   exists and runs as the `dograh-named-tunnel` container (http2, 4 edge
   connections, creds + config in the `dograh-cf-creds` docker volume).
   Hostnames routed: `voice.secondshift.space` → api:8000,
   `voice-ui.secondshift.space` → ui:3010.
   **Remaining manual step (only you can do it):** in GoDaddy
   (dcc.godaddy.com → secondshift.space → DNS → Nameservers → change),
   replace `ns21/ns22.domaincontrol.com` with
   `dom.ns.cloudflare.com` + `magnolia.ns.cloudflare.com` (DNSSEC off if
   prompted). The zone already exists in Cloudflare (account
   cb031404e172d27b1fc97fbaa8251b2f) with all 4 original records imported,
   so the site keeps working through propagation.
   **What happens automatically after the flip:** within 5 minutes the
   watchdog sees `voice.secondshift.space` go healthy, flips
   `public/dograh-endpoints.json` + `.env` to the permanent URLs, sets
   `DOGRAH_TUNNEL_MODE=named` (observe-only monitoring from then on),
   retires the quick-tunnel containers, and pushes — Render deploys the
   permanent URLs. Zero downtime, no manual commit. Quick tunnels and URL
   rotation cease to exist.
5. **If the PC itself is down:** nothing self-hosted can answer — the site
   correctly shows the gray offline state and the free mic + Vapi lines keep
   working. That limit is physics, not config.

**Limits of the free setup (be honest with yourself):**

1. **The PC must be on** for the free line to work at all. PC off → live-site
   visitors see the gray "offline" state; the free mic + Vapi lines keep working.
2. **Visitors on your Wi-Fi** connect fine (TURN host = `192.168.1.76`).
   **Visitors on mobile data / other networks** additionally need the router
   to forward **UDP 3478** to this PC (static NAT rule: external 3478/udp →
   192.168.1.76:3478). The public IPv4 here is real (not CGNAT — 38.137.51.45),
   so one port-forward finishes this. Until then, tunnel URLs alone are not
   enough for outside callers — WebRTC media can't reach coturn.
3. Quick-tunnel URLs rotate on tunnel restarts; the watchdog heals them
   within ≤5 min + Render deploy time (~1 min). A **named Cloudflare tunnel**
   on your own domain removes even that gap.

## Where transcripts go

Voice-call transcripts are **not** exposed to the embedding page by the
current widget build (its `onMessage` callback is chat-only). Every call
lands in **Dograh → Agent Runs** with full transcript + recording.
voice.html mirrors only the call lifecycle (connected/ended).

## Relationship to Vapi

Vapi stays configured and untouched. The Dograh line needs **no API keys**
(Dograh bundles its own STT/LLM/TTS stack); LLM keys for the Dograh agent
are configured in the Dograh UI (Models page) if you want a stronger brain
than the bundled one.
