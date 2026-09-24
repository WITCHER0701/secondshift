# 🚀 Deploying SecondShift — from localhost to your domain

**Short answer: yes, the site can go live the day you get a domain.** It's a plain Node app — no database server, no build step, no special hosting. Below is exactly what to do, plus an honest list of what's demo-grade vs production-grade.

---

## 1 · What you need (about $10–15/month total)

| Thing | Cost | Why |
|---|---|---|
| Domain (e.g. `secondshift.io`) | ~$10/yr | Namecheap, Cloudflare, Porkbun |
| A small VPS | $4–6/mo | Hetzner CX11, DigitalOcean, Racknerd — Ubuntu 24.04 |
| (Optional) Cloudflare free plan | $0 | DNS, CDN, bot protection |

## 2 · Deploy steps (30–60 minutes)

```bash
# on your VPS (Ubuntu)
apt update && apt install -y nodejs npm caddy
npm install -g pm2

# copy the two apps up (or git clone)
scp -r ReviewBoost/ automation-lab/ root@YOUR_SERVER:/opt/
cd /opt/automation-lab && npm install
cd /opt/ReviewBoost && npm install

# run both under pm2 (survives reboots)
# (pm2 passes --env-file on Node 20+, or upload your .env file)
pm2 start /opt/automation-lab/server.js --name secondshift -- --env-file=/opt/automation-lab/.env
pm2 start /opt/ReviewBoost/server.js --name reviewboost
pm2 save && pm2 startup   # follow the printed command

# /etc/caddy/Caddyfile — automatic HTTPS, no cert hassle
# secondshift.yourdomain.com {
#   reverse_proxy localhost:4000
# }
# api.secondshift.yourdomain.com {
#   reverse_proxy localhost:3000
# }
systemctl reload caddy
```

Point your domain's A record at the VPS IP. Caddy gets you a green padlock automatically.

## 3 · Environment variables (set before launch)

```bash
# SecondShift (/opt/automation-lab)
ADMIN_PASSWORD=<long-random-password>   # admin dashboard
SESSION_SECRET=<random-string>

# Cloud data sync (recommended — see CLOUD-SETUP.md; data survives redeploys)
CLOUD_GIST_TOKEN=ghp_...                # one-time; CLOUD_GIST_ID gets printed on first boot

# ReviewBoost (/opt/ReviewBoost) — only when selling for real
ANTHROPIC_API_KEY=sk-ant-...            # Claude writes the messages
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...                # your SMS number
BASE_URL=https://api.secondshift.yourdomain.com
```

> **Moving hosts or redeploying?** Nothing to migrate: set the same cloud vars on the new box, boot once, and the newer data copy restores automatically (your old local file is backed up as `lab.json.local-backup`).

---

## 4 · ✅ Ready for production today

- Landing, catalog, test-drive, deal capture — hardened forms, server-side validation
- Admin auth (password gate) + lead pipeline + **clients/invoices/billing**
- Review engine: multi-tenant, API-key auth, rating gate, follow-up scheduler
- Backups: all data is JSON files — `pm2 stop`, copy `data/` dirs, restart. Add a nightly cron `cp -r data/ /backups/` and you're done.

## 5 · ⚠️ Honest gaps before you take real money

| Gap | Why it matters | Effort |
|---|---|---|
| **Client payment collection** | Invoices exist but "Mark paid" is manual. Add Stripe Payment Links (10 min per client, zero code) or a Stripe Checkout integration (a day) | Small |
| **Real email sending** | Deal confirmations say "check your inbox" but no email is sent. Add Resend/Postmark (free tier) | Small |
| **JSON store → SQLite/Postgres** | Fine to ~10k records; move to a real DB when you have 10+ clients | Medium |
| **Rate limiting / spam protection** | Deal form can be spammed. Add express-rate-limit + a honeypot field | Small |
| **STOP handling for SMS** | Legally required (TCPA) before real SMS volume. Honor STOP replies in the Twilio webhook | Small but mandatory |

## 6 · Launch checklist

- [ ] Domain + A record
- [ ] HTTPS via Caddy (automatic)
- [ ] `ADMIN_PASSWORD` + `SESSION_SECRET` set
- [ ] Nightly backup cron for `data/`
- [ ] Stripe payment links created for each plan
- [ ] Test-drive page loads on mobile (it's the closer — test it on your phone)
- [ ] Send a test deal brief, confirm it lands in `/admin.html`

— Built by Rishi Raj Singh 🌙
