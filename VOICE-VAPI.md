# 📞 The Voice × Vapi — real phone lines for your voice agent

Vapi (vapi.ai) is a voice-infrastructure platform: production speech recognition,
instant barge-in (callers interrupting mid-sentence), noise handling, and real
phone numbers. This repo already speaks its protocol — connect the accounts and
The Voice answers actual phone calls with **the exact same booking brain**
(`voice-agent.js`) that runs the free web demo.

**Nothing about the brain changes.** Vapi is ears + a phone line. Our server
stays the decider — which is also your sales pitch: *"the intelligence is ours,
we just rent better ears."*

---

## Architecture

```
Caller's phone ──▶ Vapi (STT + telephony) ──▶ POST /vapi/chat/completions
                                                (OpenAI chat format)
                                                      │
                                              voice-agent.js  ← OUR brain
                                                      │
                          Vapi speaks the reply ◀── { choices:[{message}] }
```

- **Endpoint added:** `POST /vapi/chat/completions` — OpenAI-compatible. Vapi
  sends the conversation, we return the assistant's next line. Sessions are
  keyed by Vapi call ID; every call and booked appointment lands in the same
  admin dashboard as web calls (`channel: "vapi"`).
- **Auth:** set `VAPI_SERVER_SECRET` and Vapi sends it as a Bearer token.
  Requests without it get 401 (tested).
- **Web calls:** `voice.html` gains a "Pro line" panel — when the env vars
  below exist it shows a **Call on the pro line** button using the Vapi web
  SDK (browser calls, still our brain, no phone number needed).

---

## Setup (one time, ~20 minutes)

### 1 · Vapi account
Sign up at **dashboard.vapi.ai**. New accounts include free trial credit —
enough to test calls end to end before spending anything.

### 2 · Create the assistant
Dashboard → **Create Assistant** → set the **Model**:

- Provider: **Custom LLM**
- Endpoint: `https://secondshift.space/vapi/chat/completions` (your deployed URL; for local testing use an ngrok tunnel — `ngrok http 4000`)
- Authentication: **API Key** → paste the same value you'll set as `VAPI_SERVER_SECRET`

Then set:

- **First message:** `Hi, thanks for calling Demo Business! I can help with bookings or questions. What can I do for you?`
- **Transcriber:** Deepgram Nova (default is fine)
- **Voice:** any premium voice you like (this is where Vapi beats the free
  browser stack — try ElevenLabs voices)
- **Client messages:** enable `transcript` (the web panel renders live captions)

### 3 · Environment variables
In `.env` (local) or Render → Environment (production):

```
VAPI_PUBLIC_KEY=pk_xxxxxxxx        # dashboard → API Keys → Public key (safe in browser)
VAPI_ASSISTANT_ID=asst_xxxxxxxx    # the assistant you just made
VAPI_SERVER_SECRET=topsecret       # same value you typed into Vapi's auth field
```

Restart/redeploy. `voice.html` now shows the pro-line controls, and phone
calls hit your brain. (`GET /api/vapi/config` returns `configured:false` when
unset — the page stays in free mode.)

### 4 · Real phone number (optional, per client)
Vapi Dashboard → **Phone Numbers** → buy a local number (~$2/mo + per-minute
usage, typically $0.10–0.25/min all-in) → attach it to your assistant. Call it
from your cell — you'll be talking to SecondShift's brain on a real phone line.

---

## Pricing (why this is a margin machine)

| | Cost | What you charge |
|---|---|---|
| Free web agent (Kokoro + Web Speech) | **$0/mo** | included in every plan |
| Vapi web calls | ~$0.05–0.10/min | — |
| Vapi + phone number | ~$2/mo + ~$0.10–0.25/min | $600/mo (First Response tier) |

A busy salon taking ~200 calls/month × 2 min ≈ **$40–60/mo** in Vapi usage —
under 10% of the monthly fee. You can cap spend in the Vapi dashboard (assistant
usage limits) so a viral client can never surprise you.

---

## Testing checklist

1. **Bridge (no Vapi account needed):** `node scripts/voice-e2e.js` covers the
   brain; the bridge is exercised by POSTing OpenAI-format messages to
   `/vapi/chat/completions` (see VOICE-VAPI test transcript in the repo history —
   a 4-turn booking completing with `channel:"vapi"` in the admin calls list).
2. **Web pro line:** open `/voice.html` → the Vapi panel shows *ready* → click
   **Call on the pro line** → speak; live transcripts render in the call log;
   the booked appointment appears in Admin → Voice Ops.
3. **Phone line:** call the Vapi number, complete a booking, confirm the
   appointment in the dashboard.

## Notes & guards

- Sessions in the bridge expire after 2h of inactivity; `saveCall` runs on
  every turn, so transcripts are never lost even mid-call restarts.
- If Vapi is unreachable (site down), callers get Vapi's built-in fallback —
  consider setting a forwarding number in the Vapi dashboard to the client's
  real phone as a safety net.
- The free Kokoro/web-speech stack remains the default everywhere — Vapi is
  strictly an opt-in per-client upsell ("pro line").
