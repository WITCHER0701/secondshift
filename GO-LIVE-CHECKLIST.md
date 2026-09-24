# 🚀 GO LIVE — secondshift.space, step by step, zero skipped steps

Every step is marked:
- **[YOU]** — you do it in a browser or your terminal (it touches your accounts)
- **[CODEBUFF]** — ask me in chat and I'll run it in your project right now

Do the parts **in order**. Part 5 (Vapi) is placed *after* deploy on purpose — Vapi needs a public URL to reach your brain, and this order burns **$0 of the free credits** until you're ready to test.

---

## PART 1 · GitHub — put the folder on the internet (10 min)

### 1.1 [YOU] Create the GitHub account
1. Go to **github.com** → **Sign up** → use your real email → verify the code.
2. Username suggestion: something clean like `rishirajsingh` or `secondshift-app` (it appears in your repo URL).

### 1.2 [YOU] Tell git who you are (one-time, in Git Bash)
```bash
git config --global user.name "Rishi Raj Singh"
git config --global user.email "the-email-you-used-for-github"
```

### 1.3 [CODEBUFF] Commit the project
Say the word and I run: `git commit` with a clean message. (Everything is already staged; `.gitignore` already excludes `node_modules/`, `data/`, `.env`, logs — **your secrets and data never leave the laptop**.)

### 1.4 [YOU] Create the empty repo
1. Go to **github.com/new**.
2. Repository name: `secondshift`
3. Visibility: **Private** (recommended — you can make it public later)
4. **Do NOT** tick "Add a README" / ".gitignore" / "license" (the repo must stay empty so our push fits).
5. Click **Create repository**. Copy the URL shown: `https://github.com/YOURUSERNAME/secondshift.git`

### 1.5 [CODEBUFF] Connect + push
I run:
```bash
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/secondshift.git
git push -u origin main
```
> The first `git push` pops a **GitHub sign-in window** (Git Credential Manager). Sign in once — Windows remembers forever.

✅ **Checkpoint:** open your repo URL in the browser — you should see `server.js`, `public/`, `render.yaml`, all the docs.

---

## PART 2 · Render — deploy the site (10 min, $0)

### 2.1 [YOU] Create the Render account
1. Go to **dashboard.render.com** → **Sign in with GitHub** (no credit card needed).

### 2.2 [YOU] Create the service from the Blueprint
1. Top right: **New +** → **Blueprint**.
2. Pick your `secondshift` repo → Render finds `render.yaml` automatically (service name `secondshift`, Node, auto-deploy on push).
3. It asks for the secret env vars — set now:
   - `ADMIN_PASSWORD` → pick a strong password (this unlocks `secondshift.space/admin.html`)
   - `SESSION_SECRET` → Render generates one (leave the generated value)
   - `CLOUD_GIST_TOKEN` / `GIST_ID` → **leave empty for now** (Part 4)
4. Click **Create**. First build ≈ 2 min. Watch the logs — done when it says `==> Your service is live`.

### 2.3 [YOU] Smoke test the raw URL
- Open `https://secondshift.onrender.com` → homepage loads.
- Open `https://secondshift.onrender.com/healthz` → `{"ok":true,...}`.
- Open `/admin.html` → log in with the `ADMIN_PASSWORD` you set.

✅ **Checkpoint:** your whole product is live on a Render URL.

> **Free tier:** sleeps after ~15 min idle (first visitor waits ~40 s). $7/mo removes it. Data file resets on redeploy → Part 4 fixes that for free.

---

## PART 3 · Connect secondshift.space (10 min work + up to a few hours DNS wait)

### 3.1 [YOU] Add the domain in Render
1. Render → your service → **Settings → Custom Domains → Add Custom Domain** → type `secondshift.space`.
2. Render automatically adds `www` and redirects it to the root. Render will show you a **Verify** button (don't expect it green yet) and what DNS it needs.

### 3.2 [YOU] Point GoDaddy at Render
1. GoDaddy → **My Products** → `secondshift.space` → **DNS → Manage DNS**.
2. **Delete** these GoDaddy defaults (they interfere):
   - the parking **A record** (`@` → "Parked" / GoDaddy IP)
   - any **AAAA** records
   - any **Forwarding** rules
3. **Add** these two records:

| Type | Name | Value | TTL |
|---|---|---|---|
| **A** | `@` | `216.24.57.1` | 1 hour |
| **CNAME** | `www` | `secondshift.onrender.com` ← *your actual Render URL from 2.2* | 1 hour |

### 3.3 [YOU] Verify
1. Back in Render → Custom Domains → click **Verify**. DNS can take minutes to a few hours — if it fails, wait 30 min and click again.
2. Once verified, Render auto-issues the **HTTPS certificate** (free, automatic).
3. Visit **https://secondshift.space** 🎉

✅ **Checkpoint:** `https://secondshift.space/healthz` returns `{"ok":true,...}`.

---

## PART 4 · Cloud data persistence — do this BEFORE telling anyone (5 min)

On Render's free tier the local JSON resets on every redeploy. Your leads/bookings survive anyway — you already built the Gist sync, it just needs a token.

### 4.1 [YOU] Make a GitHub token
1. GitHub → click your avatar → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**
2. Note: `secondshift cloud store` · Expiration: 1 year (or no expiration) · Scopes: tick **only `gist`** ✅ — nothing else.
3. Copy the token (starts `ghp_`) — shown **once**.

### 4.2 [YOU] Add it to Render
1. Render → service → **Environment** → Add:
   - `CLOUD_GIST_TOKEN` = `ghp_...`
2. **Save Changes** (this redeploys — fine).

### 4.3 [YOU] Bootstrap the store
1. Visit `https://secondshift.space` once, submit one test brief or make one Voice call.
2. Render → **Logs** → find the line that prints the new `GIST_ID` (first cloud push auto-creates it).
3. Environment → add `GIST_ID` = that id → Save.

✅ **Checkpoint:** every future deploy pulls newest data on boot and pushes every save to the cloud. Full details in `CLOUD-SETUP.md`.

### 4.4 [YOU] Final live smoke test
- `/healthz` → ok
- `/test-drive.html` → The Voice → type + book → `/admin.html` → call + appointment visible
- `/deal.html` → submit a brief → shows in admin pipeline

---

## PART 5 · Vapi — pro voice line, using only the FREE signup credit

Vapi has no permanent free tier, but **new accounts get a one-time signup credit (~$10 ≈ 150–200 test minutes, no card required)**. Followed in this order, you spend $0 of it until the very first test call, and ~$0 while demoing locally (Part 5 is fully configured first; the credit only ticks during actual calls).

### 5.1 [YOU] Create the Vapi account (no card)
1. Go to **dashboard.vapi.ai** → **Sign up** (Google/GitHub is fastest).
2. You start with the free credit — check it under **Billing**.

### 5.2 [YOU] Copy your Public Key
Dashboard → **Settings → API Keys** (or shown on the home screen): copy the **Public Key** (`pk_...`). It's safe to expose in the browser — that's what it's for.

### 5.3 [YOU] Create The Voice assistant (the brain stays YOURS)
1. Dashboard → **Assistants → Create** → start from the **blank template**.
2. Name it: `SecondShift — The Voice`.
3. Open its **JSON editor** and replace the **model** block with (this is our custom-LLM protocol — your `server.js` IS the brain):

```json
{
  "model": {
    "provider": "custom-llm",
    "url": "https://secondshift.onrender.com/vapi/chat/completions",
    "temperature": 0.7,
    "maxTokens": 220
  }
}
```
> Use your **real Render URL**. (Optionally add `"headers": { "Authorization": "Bearer <VAPI_SERVER_SECRET>" }` if you set that secret — see 5.5.)

4. Leave **voice** and **transcriber** at the template defaults (Vapi pre-selects a solid Deepgram STT + neural voice).
5. Set **firstMessageMode** to `assistant-speaks-first` so it greets first.
6. **Save** → copy the **Assistant ID** (`uuid`-looking string) from the assistant page.

### 5.4 [YOU] Wire the keys into the site
**On Render** → Environment → add:
- `VAPI_PUBLIC_KEY` = `pk_...`
- `VAPI_ASSISTANT_ID` = the Assistant ID
- (optional) `VAPI_SERVER_SECRET` = any long random string — then put the same string in the assistant's `Authorization` header (5.3) and on your local `.env`
→ **Save** (redeploys).

**On your laptop** (for local testing) — ask me and I'll add the same values to `automation-lab/.env`.

✅ **Checkpoint:** open `https://secondshift.space/voice.html` → the **Vapi pro panel** now shows (blue "Ready" dot + "Call on this page" button) instead of the "not configured" note.

### 5.5 [YOU] First test call — spend your first free minutes (≈2–5)
1. `https://secondshift.space/voice.html` → **Call on this page** → allow the microphone when the browser asks.
2. Say: *"I'd like a haircut tomorrow at 2pm"* → give a name + phone → confirm.
3. Log into `/admin.html` → the call appears with `channel: vapi` and the appointment is saved — **the whole pro pipeline, end to end.**

> Note: Vapi's cloud must reach your server — that's why we used the Render URL. For **local** dev testing you'd need a tunnel (e.g. `ngrok http 4000`) and its URL in 5.3 — easier to just test on the live site.

### 5.6 [YOU, optional] Real phone line (~$2–3/mo + per-minute, paid from the credit)
1. Vapi → **Phone Numbers → Create/Buy** → pick a US number.
2. On the assistant: set the number's **inbound assistant** to `SecondShift — The Voice`.
3. Call it from your phone — The Voice answers. Give this number to clients; add `+1XXXXXXXXXX` → Render env `TWILIO...`-style call-forwarding only if you later want call recording/alerts (not needed).

### 5.7 Keep-it-free habits
- Test via the **web widget** (5.5) — no phone number needed, costs only per-minute during the call.
- Stop/end calls promptly; set **silenceTimeoutSeconds** (already in the template) so dead air doesn't bill.
- The $10 credit ≈ your first ~150–200 minutes of demos — plenty for prospecting calls. When real clients pay $600–1,200/mo, per-minute cost (~$0.15–0.25) is ~1% of revenue.

---

## PART 6 · Update the site later (the whole release process)

```bash
git add . && git commit -m "what changed" && git push
```
Render redeploys automatically on every push to `main`. (Or just ask me — "push an update" — and I'll run it.)

---

## 💰 Total cost to be fully live

| Item | Cost |
|---|---|
| Domain | what you already paid GoDaddy |
| Render hosting (free tier) | $0 ($7/mo for always-on later) |
| HTTPS | $0 (auto) |
| Cloud data (GitHub Gist) | $0 |
| Vapi signup credit | $0 → covers ~150–200 test minutes |
| **Monthly to run** | **$0–3** until you're ready for the $7 always-on plan |
