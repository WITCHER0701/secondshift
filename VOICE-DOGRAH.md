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

- **Stack location:** `D:\my LLM\.n8n-files\website\dograh\`
  (`docker-compose.yaml` + generated `.env` + `scripts/` + `deploy/`)
- **UI:** http://localhost:3010 (login: the account you created on first run)
- **Agent:** "SecondShift automation service tester - inbound" (workflow 1)
- **Embed token:** `DOGRAH_EMBED_TOKEN` in `automation-lab/.env`
- **Site integration:** `/api/dograh/config` on this server reads
  `DOGRAH_EMBED_TOKEN` / `DOGRAH_UI_URL` / `DOGRAH_API_URL` from `.env`;
  voice.html's green **Free line** box boots the widget from those values.
  Keep the token secret-ish: anyone with it can host your agent's widget.

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
cd "/d/my LLM/.n8n-files/website/dograh"
docker compose --profile tunnel --profile local-turn up -d

# stop
docker compose --profile tunnel --profile local-turn down
```

Test locally: open http://localhost:4000/voice.html → green **Talk on the
free line** button. From the phone on the same Wi-Fi:
`http://192.168.1.76:4000/voice.html`.

## Quick tunnels change URL on every restart ⚠️

The public URLs are trycloudflare **quick tunnels** (ephemeral). After every
stack restart, refresh both in `automation-lab/.env`, then restart the site
server:

```bash
docker logs cloudflared-tunnel | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1  # → DOGRAH_API_URL
docker logs dograh-ui-tunnel    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1  # → DOGRAH_UI_URL
```

**From the internet (phone on mobile data, real visitors), calls will not
connect** unless the PC is reachable AND the tunnel URLs in .env are current.
Stable fix when you want it: a named Cloudflare tunnel on a hostname you own
(then set the URLs once and never again), or a small VPS running the stack.

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
