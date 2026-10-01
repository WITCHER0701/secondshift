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

## Never unreachable — the four layers

1. **Self-heal (automatic, ≤5 min):** the scheduler task runs the watchdog
   every 5 minutes around the clock; it recycles dead/limbo tunnels and
   pushes fresh URLs that Render deploys in ~1 min. Downtime ceiling ≈ 6 min.
2. **Server-side eyes (automatic alert):** the site's Telegram watchdog
   probes the free line every cycle — if it's down you get a 🚨 alert with a
   **🔧 Fix: fix-dograh-tunnels** button; `/diagnose` lists it too, and
   `/health` shows a `dograh free line` row. One tap reruns the watchdog.
3. **Permanent URLs (recommended — do once):** quick tunnels rotate by
   design; a **named Cloudflare tunnel** on your own domain never does.
   The domain is already on Cloudflare, so:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create dograh
   # route two hostnames (adjust to the ports in docker-compose.yaml:
   # api 8000, ui 3010):
   cloudflared tunnel route dns dograh voice.secondshift.space
   cloudflared tunnel route dns dograh voice-ui.secondshift.space
   ```
   Then run two tunnels with `--url http://localhost:8000` / `:3010`
   (or point the existing containers at the tunnel token), put
   `https://voice.secondshift.space` / `https://voice-ui.secondshift.space`
   into `public/dograh-endpoints.json` + `.env` once, set
   `DOGRAH_TUNNEL_MODE=named` in `.env` (watchdog then only monitors — it
   never "recycles" a tunnel that cannot rotate), and keep the scheduled
   task as the monitor. Commit + push once; no more rotation commits ever.
4. **If the PC itself is down:** nothing self-hosted can answer — the site
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
