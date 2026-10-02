#!/usr/bin/env node
// dograh-watchdog.js — keeps the site's free line working 24/7.
//
// The Dograh stack runs on this PC behind trycloudflare quick tunnels whose
// URLs rotate whenever the tunnels restart. The live site learns the current
// URLs from public/dograh-endpoints.json (tracked in git, deployed to Render).
// This script, run every 5 minutes by Windows Task Scheduler
// (DograhTunnelWatchdog → scripts/dograh-watchdog.cmd):
//   1. health-checks the API tunnel URL from the endpoints file
//   2. if dead (or the tunnel is registered-dead "limbo"): restarts both
//      tunnel containers and reads the new URLs from their logs
//   3. rewrites public/dograh-endpoints.json + .env — but commits + pushes
//      ONLY when the URLs actually changed (health flaps are no-ops)
//   4. DOGRAH_TUNNEL_MODE=named skips restart logic entirely (named tunnels
//      on your own domain never rotate — see VOICE-DOGRAH.md)
//
// Env/config: DOGRAH_REPO_DIR, DOGRAH_BRANCH, WATCHDOG_TIMEOUT_MS,
// DOGRAH_TUNNEL_MODE=quick|named
// Run manually: node scripts/dograh-watchdog.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = process.env.DOGRAH_BRANCH || 'main';
const TIMEOUT = process.env.WATCHDOG_TIMEOUT_MS || '20000';
const MODE = (process.env.DOGRAH_TUNNEL_MODE || 'quick').toLowerCase();
const FILE = path.join(ROOT, 'public', 'dograh-endpoints.json');
const ENVFILE = path.join(ROOT, '.env');
// The scheduler runs us without dotenv — read our own knobs from .env when
// not set in the environment (DOGRAH_TUNNEL_MODE, DOGRAH_PERM_API/UI,
// WATCHDOG_TELEGRAM_* heal-alert creds).
// Must run BEFORE the constants below are computed.
try {
  for (const line of fs.readFileSync(ENVFILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*((?:DOGRAH_|WATCHDOG_TELEGRAM_)[A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch (_) { /* .env optional */ }

const API_TUNNEL = 'cloudflared-tunnel';
const UI_TUNNEL = 'dograh-ui-tunnel';
// Permanent named-tunnel hostnames (created once; never rotate). When these
// go live, the watchdog flips the endpoints file from quick-tunnel URLs to
// them automatically and retires the quick-tunnel containers.
const PERM_API = (process.env.DOGRAH_PERM_API || 'https://voice.secondshift.space').replace(/\/$/, '');
const PERM_UI = (process.env.DOGRAH_PERM_UI || 'https://voice-ui.secondshift.space').replace(/\/$/, '');

// Windows-hardened shell runner. The previous execSync version hung forever
// inside Node's captured stdout pipe when a child (docker on a busy daemon)
// stalled without exiting — that wedged the 01:03 scheduler run, and the
// task's "ignore new instances" policy then blocked every later heal. This
// version: real timeout with killTree, no reliance on child exit to flush
// pipes, and a stdout cap so a chatty child can't balloon memory.
function sh(cmd, opts = {}) {
  const timeout = Number((opts && opts.timeout) || TIMEOUT) + 5000;
  return new Promise((resolve, reject) => {
    let out = '', done = false;
    let child;
    try {
      child = spawn(cmd, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return reject(e); }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }, timeout);
    child.stdout && child.stdout.on('data', (d) => { if (out.length < 400000) out += d; });
    child.stderr && child.stderr.on('data', (d) => { if (out.length < 400000) out += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(killer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`sh exit ${code}: ${cmd} :: ${out.trim().slice(-200)}`));
    });
  });
}
const log = (m) => console.log(`[dograh-watchdog ${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Telegram heal alerts — your phone knows what this PC fixed ────────
// The bot itself lives on Render (it owns getUpdates long-polling), so the
// watchdog only SENDS one-shot messages and never polls — it can never fight
// the Render bot for updates. Credentials live in PC .env as
// WATCHDOG_TELEGRAM_BOT_TOKEN / WATCHDOG_TELEGRAM_CHAT_ID (distinct names on
// purpose: plain TELEGRAM_* in the PC .env would make server.js start a
// second poller that steals updates from Render).
const TG_TOKEN = process.env.WATCHDOG_TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.WATCHDOG_TELEGRAM_CHAT_ID || '';
const ALERTS_STATE = path.join(ROOT, 'watchdog.alerts.json');
function readAlertState() { try { return JSON.parse(fs.readFileSync(ALERTS_STATE, 'utf8')); } catch (_) { return {}; } }
async function tgNotify(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    log(`telegram heal alerts not configured (add WATCHDOG_TELEGRAM_BOT_TOKEN + WATCHDOG_TELEGRAM_CHAT_ID to .env) — would have sent: ${text.split('\n')[0]}`);
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) { log('telegram alert delivered'); return true; }
    log(`telegram alert failed: HTTP ${r.status} ${j && j.description ? j.description : ''}`);
  } catch (e) { log(`telegram alert failed: ${e.message}`); }
  return false;
}
// Cooldown per alert kind so a flapping tunnel can't flood the chat: heals at
// most every 10 min, still-down warnings at most every 30 min.
const ALERT_COOLDOWN_MS = { heal: 10 * 60 * 1000, down: 30 * 60 * 1000 };
async function alertOnce(kind, text) {
  const st = readAlertState();
  const last = st[kind + 'AlertAt'] || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS[kind]) {
    log(`${kind} alert suppressed (cooldown, ${Math.max(0, Math.round((ALERT_COOLDOWN_MS[kind] - (Date.now() - last)) / 60000))}m left)`);
    return;
  }
  if (await tgNotify(text)) {
    st[kind + 'AlertAt'] = Date.now();
    try { fs.writeFileSync(ALERTS_STATE, JSON.stringify(st)); } catch (_) {}
  }
}
// WATCHDOG_SLEEP_MS scales all fixed waits (tests set it tiny).
const SLEEP = Number(process.env.WATCHDOG_SLEEP_MS) || 1000;
const HEALTH_WAIT = Number(process.env.WATCHDOG_HEALTH_WAIT_MS) || 180000;
const POLL = 10 * SLEEP;
// Quick-tunnel recreate args — must match the containers originally deployed
// (see VOICE-DOGRAH.md). Recreating (rm + run) instead of restarting: a
// restarted quick tunnel can keep retrying its dead registration ("Tunnel
// not found" limbo) and never gets a fresh URL.
const RECREATE_ARGS = {
  [API_TUNNEL]: `--name ${API_TUNNEL} --restart unless-stopped --network dograh_app-network -p 2000:2000 cloudflare/cloudflared:latest tunnel --no-autoupdate --protocol http2 --url http://api:8000 --metrics 0.0.0.0:2000`,
  [UI_TUNNEL]: `--name ${UI_TUNNEL} --restart unless-stopped --network dograh_app-network cloudflare/cloudflared:latest tunnel --no-autoupdate --protocol http2 --url http://ui:3010 --metrics 0.0.0.0:2001`,
};
async function recreateTunnels() {
  await sh(`docker rm -f ${API_TUNNEL} ${UI_TUNNEL}`);
  for (const [name, args] of Object.entries(RECREATE_ARGS)) await sh(`docker run -d ${args}`);
}
/** True when cloudflared registered a connection in the last 12 minutes —
 *  the URL itself may still be propagating through Cloudflare's edge (530s),
 *  so recycling now would just churn URLs. */
async function freshRegistration() {
  try {
    const logs = await sh(`docker logs ${API_TUNNEL} --since 12m 2>&1`);
    return /Registered tunnel connection/.test(logs);
  } catch (e) { return false; }
}
/** Quick tunnels can silently re-register under a NEW url (observed on this
 *  NAT: old name NXDOMAINs, container still up, new name in logs). When the
 *  newest logged URL differs from the (dead) endpoints one, adopt it.
 *  Returns true when an adoption was made (or was already current). */
async function adoptNewerIfRotated(ep) {
  const loggedApi = await tunnelUrl(API_TUNNEL, '--since 30m');
  if (!loggedApi || loggedApi === ep.apiUrl) return false;
  const loggedUi = (await tunnelUrl(UI_TUNNEL, '--since 30m')) || ep.uiUrl;
  log(`self-rotated quick tunnel detected (${ep.apiUrl} → ${loggedApi}) — adopting newest logged URLs`);
  await adoptUrls(loggedApi, loggedUi);
  await alertOnce('heal', `🔄 Dograh self-healed — the quick tunnel rotated its URL on its own; I adopted the newest one and the site is already serving it. Nothing to do.\napi: ${loggedApi}`);
  return true;
}

function readEndpoints() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}

async function healthy(url) {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Number(TIMEOUT));
    const r = await fetch(url.replace(/\/$/, '') + '/api/v1/health', { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (e) { return false; }
}

async function tunnelUrl(container, sinceArg) {
  try {
    const logs = await sh(`docker logs ${container} ${sinceArg} 2>&1`);
    const m = logs.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g);
    return m ? m[m.length - 1] : null; // most recent registration wins
  } catch (e) { return null; }
}

/** True when cloudflared is up but stuck retrying a server-side dead tunnel. */
async function tunnelInLimbo(container) {
  try {
    const logs = await sh(`docker logs ${container} --since 10m 2>&1`);
    return /Tunnel not found/.test(logs);
  } catch (e) { return false; }
}/** Shared tail for adopting a set of URLs: no-op guard, endpoints + .env,
 *  commit + push (only when URLs actually changed). */
async function adoptUrls(api, ui) {
  const prev = readEndpoints();
  if (prev.apiUrl === api && prev.uiUrl === ui) {
    log(`URLs unchanged (${api}) — file already current, skipping commit`);
    return;
  }
  const ep = { ...prev, token: prev.token || '', uiUrl: ui, apiUrl: api, updatedAt: new Date().toISOString() };
  if (!ep.token) { log('ERROR: endpoints file had no token; not overwriting'); process.exit(1); }
  fs.writeFileSync(FILE, JSON.stringify(ep, null, 2) + '\n');
  // keep local .env in sync for the local server (created if missing)
  try {
    let env = '';
    try { env = fs.readFileSync(ENVFILE, 'utf8'); } catch (_) { /* first run */ }
    const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + (env && !env.endsWith('\n') ? '\n' : '') + `${k}=${v}\n`; };
    set('DOGRAH_API_URL', api); set('DOGRAH_UI_URL', ui);
    fs.writeFileSync(ENVFILE, env);
  } catch (e) { /* .env optional */ }
  log(`new URLs: api=${api} ui=${ui} — committing`);
  try {
    await sh('git add public/dograh-endpoints.json');
    await sh(`git commit -m "chore: refresh Dograh tunnel endpoints (watchdog)"`);
    await sh(`git push origin ${BRANCH}`);
    log('pushed — Render will auto-deploy the new endpoints');
  } catch (e) {
    log(`git push failed: ${String(e.message).slice(0, 200)} (file updated locally; will retry next run)`);
  }
}

async function recycle(reason) {
  log(`tunnel DEAD — recreating ${API_TUNNEL} + ${UI_TUNNEL} (fresh registrations)`);
  try { await recreateTunnels(); } catch (e) { log(`recreate failed: ${e.message}`); }
  // quick tunnels print their hostname a few seconds after boot
  await sleep(15 * SLEEP);
  let api = await tunnelUrl(API_TUNNEL, '--since 2m');
  let ui = await tunnelUrl(UI_TUNNEL, '--since 2m');
  if (!api || !ui) {
    log('no URLs yet — one more recreate');
    try { await recreateTunnels(); } catch (e) { /* logged next parse */ }
    await sleep(15 * SLEEP);
    api = await tunnelUrl(API_TUNNEL, '--since 2m');
    ui = await tunnelUrl(UI_TUNNEL, '--since 2m');
  }
  if (!api || !ui) {
    await alertOnce('down', `⚠️ Dograh free line is STILL DOWN — I could not get new tunnel URLs this run. I retry automatically every 5 minutes; visitors can still use the pro line.${reason ? '\n(' + reason + ')' : ''}`);
    log('ERROR: no new tunnel URLs in logs — giving up this run');
    process.exit(1);
  }

  // Edge propagation for a brand-new quick URL can take a couple of minutes
  // (530s until then). Wait — bounded — so we never commit URLs we never saw
  // answer; the freshRegistration() grace protects the next cycles meanwhile.
  log(`waiting up to ${Math.round(HEALTH_WAIT / 1000)}s for the new tunnels to answer…`);
  const deadline = Date.now() + HEALTH_WAIT;
  let ok = false;
  while (Date.now() < deadline) { if (await healthy(api)) { ok = true; break; } await sleep(POLL); }
  if (!ok) log('WARNING: new tunnels not answering yet — committing anyway; grace logic protects the next runs');

  await adoptUrls(api, ui);
  await alertOnce('heal', `🛠 Dograh self-healed — ${reason || 'the free line was unreachable'}. Tunnels recreated, new URLs adopted, and the site updates itself automatically. Nothing to do.\napi: ${api}`);
}

async function main() {
  let ep = readEndpoints();

  // ── one-time transition: permanent URLs live → adopt them everywhere ──
  if ((ep.apiUrl || '').includes('trycloudflare.com') && (await healthy(PERM_API))) {
    log(`permanent tunnel is live (${PERM_API}) — switching endpoints away from quick tunnels`);
    ep = { ...ep, token: ep.token || '', uiUrl: PERM_UI, apiUrl: PERM_API, updatedAt: new Date().toISOString() };
    fs.writeFileSync(FILE, JSON.stringify(ep, null, 2) + '\n');
    try {
      let env = '';
      try { env = fs.readFileSync(ENVFILE, 'utf8'); } catch (_) { /* first run */ }
      const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + (env && !env.endsWith('\n') ? '\n' : '') + `${k}=${v}\n`; };
      set('DOGRAH_API_URL', PERM_API); set('DOGRAH_UI_URL', PERM_UI); set('DOGRAH_TUNNEL_MODE', 'named');
      fs.writeFileSync(ENVFILE, env);
    } catch (e) { /* .env optional */ }    try {
      await sh(`docker rm -f ${API_TUNNEL} ${UI_TUNNEL}`); log('quick-tunnel containers retired');
    } catch (e) { log(`quick-tunnel cleanup skipped: ${e.message}`); }
    try {
      await sh('git add public/dograh-endpoints.json');
      await sh(`git commit -m "chore: switch Dograh free line to permanent tunnel URLs (watchdog)"`);
      await sh(`git push origin ${BRANCH}`);
      log('pushed — Render will deploy the permanent URLs');
    } catch (e) {
      log(`git push failed: ${String(e.message).slice(0, 200)} (file updated locally)`);
    }
    await tgNotify(`🎉 Dograh is PERMANENT — ${PERM_API} answered and is now the official free-line URL. Quick tunnels retired; no more URL rotation, ever. (One-time cutover alert.)`);
    log('done');
    return;
  }

  if (MODE === 'named') {
    log(await healthy(ep.apiUrl) ? `named tunnel healthy: ${ep.apiUrl}` : `WARNING: named tunnel NOT healthy: ${ep.apiUrl || '(none)'}`);
    log('done');
    return;
  }

  if (await healthy(ep.apiUrl)) {
    if (await tunnelInLimbo(API_TUNNEL)) {
      // URL answers but cloudflared keeps retrying a dead registration —
      // this is the 21-hour crash-loop state; recycle before it rots.
      log('tunnel answers but cloudflared is in limbo (Tunnel not found) — recycling proactively');
      await recycle('the tunnel answered but cloudflared was crash-looping on a dead registration (limbo) — recycled proactively');
    } else {
      log(`tunnel healthy: ${ep.apiUrl}`);
    }
  } else if (await adoptNewerIfRotated(ep)) {
    // quick-tunnel re-registered itself under a NEW url (observed on this
    // NAT) — adopt the newest logged URLs instead of recycling containers
    // that are perfectly alive (heal alert fires inside).
  } else if (await freshRegistration()) {
    // dead URL but cloudflared just (re)registered — the 530 is propagation,
    // not a dead tunnel; recycling here would churn URLs every 5 minutes.
    log('tunnel dead but a fresh edge registration exists — URL propagation; waiting for next cycle');
  } else {
    await recycle('the free line was unreachable');
  }
  log('done');
}

// heartbeat: the in-server sentinel (server.js) stats this file to decide
// whether the scheduler is actually running us — if the mtime goes stale
// while the free line is down, the server runs the watchdog itself.
process.on('exit', () => { try { fs.writeFileSync(path.join(ROOT, 'watchdog.heartbeat'), String(Date.now())); } catch (_) { /* best effort */ } });

main().catch((e) => { log(`FATAL ${e.stack || e}`); process.exit(1); });
