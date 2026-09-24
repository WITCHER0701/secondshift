# 🚀 SecondShift Live — secondshift.space on Render

**Goal:** your site, live at `https://secondshift.space` (and `www.secondshift.space`), auto-deploying from GitHub, HTTPS included, ~$0/month.

The whole thing is **four short sessions** (~30 min total, mostly waiting on DNS).

---

## 0 · What you have already

Everything deployable is in this folder (`automation-lab/`):

- `server.js` — reads `PORT` (Render sets it), binds fine behind a proxy
- `/healthz` — health endpoint for Render's checks
- `render.yaml` — the Blueprint (Render reads it automatically)
- `logo.png`, `favicon.png`, `apple-touch-icon.png` — brand assets, wired into every page
- Data persists to a local JSON file + (optionally) your GitHub Gist cloud — **this matters, see step 4**

---

## 1 · Push the repo to GitHub (~10 min)

```bash
cd automation-lab
git init
git add .
git commit -m "SecondShift — initial deploy"
```

Create a **private** repo at github.com/new (name it `secondshift`), then:

```bash
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/secondshift.git
git push -u origin main
```

> `.gitignore` already excludes `node_modules/`, `data/`, `.env`, and logs — your secrets and local data never leave your machine.

---

## 2 · Deploy on Render (~10 min)

1. Go to **dashboard.render.com** → sign in with GitHub (no card needed).
2. **New → Blueprint**, pick your `secondshift` repo → Render reads `render.yaml`.
3. When prompted for env vars:
   - `ADMIN_PASSWORD` → pick a strong one (this unlocks `/admin.html`)
   - `CLOUD_GIST_TOKEN` / `GIST_ID` → leave empty for now (step 4)
4. Click **Create**. First build takes ~2 min.
5. You get a URL like `https://secondshift.onrender.com` — open it. Your whole site is live.

**Free-tier note:** the free instance sleeps after ~15 min idle; the first visitor after a nap waits ~40s. When you start closing deals, $7/mo removes sleep entirely. Also: on free, the local JSON file resets on redeploy — **step 4 makes your data survive anyway.**

---

## 3 · Connect secondshift.space (~10 min + DNS wait)

1. In your Render service: **Settings → Custom Domains → Add Custom Domain** → `secondshift.space`. Render automatically adds `www` and redirects it to the root.
2. Render shows you exactly what DNS it needs. In **GoDaddy → My Products → secondshift.space → DNS → Manage DNS**:

| Type | Name | Value | TTL |
|---|---|---|---|
| **A** | `@` | `216.24.57.1` | 1h |
| **CNAME** | `www` | `secondshift.onrender.com` (your Render URL) | 1h |

3. **Delete** any GoDaddy defaults that would interfere: the parking **A record** (`@` → "Parked"), any **AAAA** records, and any **Forwarding** rules.
4. Back in Render, click **Verify**. HTTPS cert issues automatically within minutes.
5. Visit **https://secondshift.space** 🎉

(DNS can take from minutes to a few hours. If Verify fails, wait 30 min and retry.)

---

## 4 · Turn on cloud data persistence (2 min, do this before announcing the site)

Your leads, calls, bookings and invoices should survive redeploys. You already built this — it just needs the token:

1. GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate → check **only `gist`**.
2. Render Dashboard → your service → **Environment** → add:
   - `CLOUD_GIST_TOKEN` = the token
3. Save (this redeploys). Visit the site once, make a test submission — the first cloud push **auto-creates the store** and logs a `GIST_ID` in the Render logs. Copy that ID into a second env var `GIST_ID`.
4. Done — every future deploy pulls the newest data on boot and pushes every save to the cloud. Full details in `CLOUD-SETUP.md`.

---

## 5 · Smoke test the live site

- `https://secondshift.space/healthz` → `{"ok":true,...}`
- Run one test drive: `/test-drive.html` → The Voice → book something
- Log into `/admin.html` → Voice Ops → the call you just made is there
- Submit a deal brief → it lands in the admin pipeline

---

## Updating the site later

```bash
git add . && git commit -m "update" && git push
```

Render redeploys automatically on every push to `main`. That's the whole release process.

---

## Costs

| Item | Cost |
|---|---|
| Domain (already rented) | what you paid GoDaddy |
| Render free instance | $0 (sleeps; $7/mo to always-on) |
| HTTPS | $0 (auto) |
| Cloud data (GitHub Gist) | $0 |
| **Total to be live** | **$0/mo** |
