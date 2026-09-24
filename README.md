# 🌙 SecondShift

**Your business, working after you close.**

A crew of AI automations for restaurants, salons, auto shops and local services — built, shipped and operated by **Rishi Raj Singh**. Prospects watch the shift work live on this site, then hire it.

Apple-grade dark UI · layered parallax · scroll experience engine · fully functional backend · zero build tools.

## Run it

```bash
cd automation-lab
npm install
npm start
# → http://localhost:4000
```

| Page | Purpose |
|---|---|
| `/` | Parallax landing — hero, marquee, scrollytelling, Rishi's owner card |
| `/automations.html` | The crew: four systems, live pricing, feature lists |
| `/test-drive.html` | **The closer** — trigger an automation, watch every step fire in a phone simulator (interactive rating gate) |
| `/deal.html` | "Hire the shift" form — validated, saved, confirmed with reference ID |
| `/process.html` | How the engagement works + FAQ + owner card |
| `/admin.html` | **Rishi's private pipeline** — leads, statuses, live event feed, cloud sync status (password: `lab-admin-2026`, override with `ADMIN_PASSWORD`) |

## Customize the crew

Edit `scripts/seed.js`. Each automation is one object:

```js
{
  slug: 'review-automation',       // used in URLs
  name: 'Review Automation',
  tagline: 'Every happy customer asks for it. You never do.',
  icon: '⭐',
  accent: '#f59e0b',               // card glow color
  price: 750,  priceLabel: '$750/mo',
  sellTo: 'Restaurants, salons, auto repair shops',
  outcome: 'Google profile goes from 14 reviews to 200+...',
  bullets: [ '...', '...' ],
  steps: [ { title, desc } ],      // shown in the test-drive checklist
  demo: { kind: 'review-gate' },   // 'review-gate' gets the interactive SMS demo
  order: 1,
}
```

To reset the data: delete `data/lab.json` and restart.

## Wiring the test-drive to the real product

`test-drive.html` currently runs the flow locally so it works with zero infra.
When you want the button to hit your **actual** running ReviewBoost (sibling
project at the repo root), change the review-automation script entry to
`fetch('http://localhost:3000/api/v1/requests', ...)` with your tenant API key —
the SMS + rating gate then run against the live engine.

## Your data, in the cloud (free)

Every deal brief, call, appointment, qualified lead, content week, client and invoice is synced to a free cloud store automatically — the site keeps working in local-only mode with zero setup, and activates the moment you add one token (GitHub Gist or Firebase — see **CLOUD-SETUP.md**). Newest copy wins on boot, so renting a domain + hosting later is a non-event: set the same two env lines and your data is already there.

## Deploy

Static pages + one Node process. Works as-is on:
- A $4 VPS behind Caddy (`caddy secondshift.yourdomain.com` → proxy :4000)
- Fly.io / Render / Railway (start command: `npm start`)
- Any VPS with `pm2 start server.js`

Set `ADMIN_PASSWORD` and `SESSION_SECRET` in production.

— Built by Rishi Raj Singh 🌙
