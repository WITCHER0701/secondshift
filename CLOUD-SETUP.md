# ☁️ SecondShift — Free Cloud Storage Setup

Your website's collected data — **deal briefs, test-drive events, calls, booked appointments, qualified leads, generated content weeks, clients, invoices** — now syncs to a free cloud automatically. The site keeps working exactly as now (local file), and a cloud copy rides along silently.

**You have nothing to configure today.** When you're ready (2 minutes), pick ONE of the options below.

---

## How it works

```
Visitor submits a deal brief ─┐
Test drive fires an event ────┼─▶ data/lab.json (working copy, instant)
Call books an appointment ────┘        │
                                       └─▶ (4s debounce) ☁️ cloud copy updated
Server boots ─▶ pull cloud copy ─▶ newer? restore + back up local : keep local
```

- **Newest-wins restore**: if the cloud copy is newer than local (new machine, redeploy, crash), it's restored automatically and your local file is backed up as `lab.json.local-backup`.
- **Everything still works with zero cloud configured** — local-only mode, same behavior as today.
- **No lock-in**: the cloud copy is plain JSON. Export anytime.

---

## Option A — GitHub Gist (recommended, 2 minutes)

A private Gist is a free, unlisted JSON store with API access. No credit card, no app registration.

1. Create a GitHub account (you have one) → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**
2. Check **only** the `gist` scope. Generate. Copy the token (`ghp_…`).
3. Create `.env` next to `server.js` in `automation-lab/` (or set env vars on your host):

```env
CLOUD_GIST_TOKEN=ghp_yourtokenhere
```

That's it. On the first save, the app creates a private gist and prints the ID to the server console:

```
[cloud] First push done. Add this line to .env to reuse the same store:
        CLOUD_GIST_ID=5f3a…      ← copy this back into .env
```

4. Add the printed `CLOUD_GIST_ID=…` line to `.env` so every future push updates **the same** store.

**Verify:** Admin dashboard → the status bar under the KPIs shows `gist cloud sync on · N pushes · last HH:MM`. Buttons: **Push now** / **Pull now**.

Limits (free): a gist holds files up to ~10 MB; our JSON will be KBs for years of leads. 5,000 API calls/hour — irrelevant at this scale.

> `.env` is loaded automatically — `server.js` reads simple `KEY=value` lines from `automation-lab/.env` at startup (values already set in the environment win). On a host, either upload the `.env` file or use the host's env-var settings instead.

---

## Option B — Firebase Realtime Database (Spark free plan)

1. console.firebase.google.com → **Add project** (disable Analytics, it's not needed)
2. **Build → Realtime Database → Create Database** → choose **United States** (or your region) → **Start in test mode** (fine to start; lock down later)
3. Copy the URL shown at the top of the data panel (`https://YOUR-PROJ-default-rtdb.firebaseio.com`)
4. Add to env:

```env
FIREBASE_DB_URL=https://YOUR-PROJ-default-rtdb.firebaseio.com
```

No token needed in test mode. To lock down later: Rules → replace with `{"rules": {".read": false, ".write": false}}` for public, and instead use a legacy DB secret (Project settings → Service accounts → Database secrets) plus `FIREBASE_DB_SECRET=…`.

Free tier: 1 GB stored, 10 GB/month bandwidth, 100 simultaneous connections — this app uses kilobytes.

> **Pick one provider.** If both are set, Gist wins.

---

## What this means for your launch checklist

- **Rent a domain + rent hosting whenever you're ready** — the data is already in the cloud. On the new server: set the same two env lines → boot → the newer copy restores automatically.
- **Rehearse the move anytime**: push from here, boot a copy anywhere (or locally with different SECONDSHIFT_DB), watch it restore.
- **Multiple test machines stay in sync** automatically (newest-wins).

## Environment variables summary

| Variable | Required | Purpose |
|---|---|---|
| `CLOUD_GIST_TOKEN` | for Gist | GitHub classic PAT with `gist` scope |
| `CLOUD_GIST_ID` | after first push | Pin every push to the same gist |
| `FIREBASE_DB_URL` | for Firebase | Your RTDB URL |
| `FIREBASE_DB_SECRET` | optional | If you lock down RTDB rules |
| `SECONDSHIFT_DB` | never | Override data file path (used by tests) |

## Files

| File | Role |
|---|---|
| `cloud-store.js` | Providers, debounce, restore-on-boot, status |
| `data-store.js` | Calls `schedulePush` on every save; exposes status/pushNow/restore |
| `server.js` | Boot-time restore + `/admin/api/cloud*` routes |
| Admin dashboard | Cloud status bar + Push now / Pull now |
| `scripts/cloud-e2e.js` | 12-check E2E against a mock Gist API |

## Test suite

```bash
node scripts/cloud-e2e.js     # 12 checks: push, restore, backup, newest-wins, fallback
```
