# 📞 SecondShift — The Voice (free voice agent)

A complete, working voice agent for booking appointments. **$0/month in its default configuration** — no paid APIs anywhere in the core loop.

Prospects try it live at **`/voice.html`**: press the mic (or type), talk to it, and it books a real appointment that lands in the admin **Voice Ops** tab.

---

## How it works (the free stack)

```
┌────────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│  SPEECH IN (free)  │     │   BRAIN (free)       │     │  SPEECH OUT (free) │
│  Browser Web Speech│ ──▶ │  voice-agent.js      │ ──▶ │  Kokoro-82M neural │
│  API (Chrome/Edge) │     │  slot-filling engine │     │  in-browser, WASM  │
│  -or- Whisper self-│     │  -or- local LLM      │     │  -or- Piper self-  │
│  hosted            │     │  (Ollama, optional)  │     │  hosted            │
└────────────────────┘     └──────────────────────┘     └────────────────────┘
```

Every layer has a free default and an optional upgrade:
| Layer | Free default (zero keys) | Optional free upgrade |
|---|---|---|
| Listen (STT) | **Web Speech API** — built into Chrome/Edge, no server, no key | Self-hosted **faster-whisper** (`pip install faster-whisper`, runs on CPU) |
| Think | **Deterministic slot-filling engine** (`voice-agent.js`) — regex/intent based, never hallucinates, always books | **Ollama** — `ollama pull llama3.2` then set `OLLAMA_URL=http://localhost:11434` |
| Speak (TTS) | **Kokoro-82M** neural voice — open-source (Apache-2.0), runs in the visitor's browser via WASM/Web Worker, no server cost, sounds genuinely human | Self-hosted **Piper** for phone lines, or Kokoro **fp16/f32** for even higher fidelity on capable machines |
| Phone line | *None needed for demos* — works on the web | See "Real phone calls" below |

The brain is intentionally deterministic: for *booking* tasks, a rules engine that always captures service/time/name/phone and always confirms is **more reliable than an LLM**, and it can never invent a booking. The LLM slot is there for natural phrasing, not for decisions.

---

## The conversation engine (`voice-agent.js`)

State machine:
`greeting → collect_service → collect_time → collect_name → collect_phone → confirm → done`

What it handles (all covered by tests in `scripts/voice-e2e.js` and the inline scenario suite):

- **Slot merging** — "can I get a haircut tomorrow at 5pm" fills two slots in one turn
- **Side questions anywhere** — "what are your hours?", "how much is an oil change?" answered mid-flow, then booking resumes exactly where it left off (even remembering the service you mentioned in the question)
- **Reschedule** — "no" at confirmation re-asks only the time, skipping name/phone
- **Freeform services** — anything it doesn't recognize ("engine diagnostics check") is accepted as-is instead of dead-looping
- **Human time parsing** — "tomorrow at 3pm", "Saturday 11am", "tonight 7pm", "at 3" (→ 3pm), "nine in the morning"
- **Short names** — "Bo" works; filler words ("can", "I want") never leak into stored data

### Per-industry service menus

The agent is multi-tenant-ready. Set two env vars per client:

```bash
VOICE_BUSINESS_NAME="Bella Vista Ristorante"
VOICE_BUSINESS_TYPE="restaurant"      # auto repair shop | salon | restaurant | clinic | generic
```

Each industry ships with its own keyword map and service menu (e.g. "table reservation" for restaurants, "hair color" for salons). Unknown industries get a generic menu — and unknown *services* are accepted freeform, so it never gets stuck.

---

## HTTP API

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/voice/start` | POST | public | Start a call → `{ callId, reply }` |
| `/api/voice/turn` | POST | public | Send caller text `{ callId, text }` → `{ reply, done }` |
| `/api/voice/session/:id` | GET | public | Full session: state, slots, transcript |
| `/api/voice/calls` | GET | admin | Last 50 call records |
| `/api/voice/appointments` | GET | admin | Booked appointments |

Every booking is written to `data/lab.json` → `appointments`, visible in **Admin → Voice Ops** alongside the full transcript of every call.

**Test it:** with the server running, `node scripts/voice-e2e.js` drives a complete booking conversation over HTTP and verifies it in the admin API (12 checks).

---

## Real phone calls later (when a client pays for it)

The brain is transport-agnostic — it only ever sees text and returns text. Three paths, cheapest first:

### 1. Twilio with your own Whisper + Piper (recommended)
- Twilio number (~$1.15/mo + ~$0.014/min). Point the number's webhook at your server.
- Twilio sends you **recordings** of callers; you transcribe with self-hosted faster-whisper (free), feed text to `voice-agent.advance()`, and reply with TwiML `<Say>` or self-hosted Piper audio.
- **Cost: ~$1–30/month per client depending on call volume.** You charge $600/mo for The Voice.

### 2. Twilio + their built-in speech recognition
- `<Gather input="speech">` does STT for you; no self-hosting at all. Fastest to ship, slightly higher per-minute cost.

### 3. Fully open-source SIP (zero ongoing software cost)
- **Asterisk** or **FreeSWITCH** PBX + a SIP trunk (e.g. ~$0.006/min from wholesale providers) + faster-whisper + Piper.
- Most work, literally zero software licensing. Good flagship "we run our own stack" story later.

Implementation shape (same for all three): a small adapter that turns an inbound call event into `POST /api/voice/start`, relays transcription text to `/api/voice/turn`, and returns the agent's reply as audio. The `voice-agent.js` core does not change.

---

## Files

| File | Role |
|---|---|
| `voice-agent.js` | The brain: intents, slot filling, time/service/name/phone parsing, industry menus |
| `public/voice.html` | The live call interface: mic (Web Speech API), waveform, live transcript, TTS voice, text fallback |
| `scripts/voice-e2e.js` | HTTP smoke test — run with the server up |
| Admin → **Voice Ops** | Every call transcript + booked appointments |
