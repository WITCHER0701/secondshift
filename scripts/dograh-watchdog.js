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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = process.env.DOGRAH_BRANCH || 'main';
const TIMEOUT = process.env.WATCHDOG_TIMEOUT_MS || '20000';
const MODE = (process.env.DOGRAH_TUNNEL_MODE || 'quick').toLowerCase();
const FILE = path.join(ROOT, 'public', 'dograh-endpoints.json');
const ENVFILE = path.join(ROOT, '.env');
// The scheduler runs us without dotenv — read our own knobs from .env when
// not set in the environment (DOGRAH_TUNNEL_MODE, DOGRAH_PERM_API/UI).
// Must run BEFORE the constants below are computed.
try {
  for (const line of fs.readFileSync(ENVFILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(DOGRAH_[A-Z_]+)\s*=\s*(.*)\s*$/);
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

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, timeout: Number(TIMEOUT) + 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
const log = (m) => console.log(`[dograh-watchdog ${new Date().toISOString()}] ${m}`);

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

function tunnelUrl(container, sinceArg) {
  try {
    const logs = sh(`docker logs ${container} ${sinceArg} 2>&1`);
    const m = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return m ? m[m.length - 1] : null; // most recent registration wins
  } catch (e) { return null; }
}

/** True when cloudflared is up but stuck retrying a server-side dead tunnel. */
function tunnelInLimbo(container) {
  try {
    const logs = sh(`docker logs ${container} --since 10m 2>&1`);
    return /Tunnel not found/.test(logs);
  } catch (e) { return false; }
}

async function recycle() {
  log(`tunnel DEAD — restarting ${API_TUNNEL} + ${UI_TUNNEL}`);
  try { sh(`docker restart ${API_TUNNEL} ${UI_TUNNEL}`); } catch (e) { log(`restart failed: ${e.message}`); }
  // quick tunnels print their hostname a few seconds after boot
  await new Promise((r) => setTimeout(r, 15000));
  let api = tunnelUrl(API_TUNNEL, '--since 2m');
  let ui = tunnelUrl(UI_TUNNEL, '--since 2m');
  if (!api || !ui) {
    log('no URLs yet — one more recycle');
    try { sh(`docker restart ${API_TUNNEL} ${UI_TUNNEL}`); } catch (e) { /* logged next parse */ }
    await new Promise((r) => setTimeout(r, 15000));
    api = tunnelUrl(API_TUNNEL, '--since 2m');
    ui = tunnelUrl(UI_TUNNEL, '--since 2m');
  }
  if (!api || !ui) { log('ERROR: no new tunnel URLs in logs — giving up this run'); process.exit(1); }

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
  log(`new URLs: api=${api} ui=${ui} — verifying`);
  await new Promise((r) => setTimeout(r, 5000));
  if (!(await healthy(api))) log('WARNING: new API tunnel not healthy yet (may need another cycle)');
  try {
    sh('git add public/dograh-endpoints.json');
    sh(`git commit -m "chore: refresh Dograh tunnel endpoints (watchdog)"`);
    sh(`git push origin ${BRANCH}`);
    log('pushed — Render will auto-deploy the new endpoints');
  } catch (e) {
    log(`git push failed: ${String(e.message).slice(0, 200)} (file updated locally; will retry next run)`);
  }
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
    } catch (e) { /* .env optional */ }
    try { sh(`docker rm -f ${API_TUNNEL} ${UI_TUNNEL}`); log('quick-tunnel containers retired'); } catch (e) { log(`quick-tunnel cleanup skipped: ${e.message}`); }
    try {
      sh('git add public/dograh-endpoints.json');
      sh(`git commit -m "chore: switch Dograh free line to permanent tunnel URLs (watchdog)"`);
      sh(`git push origin ${BRANCH}`);
      log('pushed — Render will deploy the permanent URLs');
    } catch (e) {
      log(`git push failed: ${String(e.message).slice(0, 200)} (file updated locally)`);
    }
    log('done');
    return;
  }

  if (MODE === 'named') {
    log(await healthy(ep.apiUrl) ? `named tunnel healthy: ${ep.apiUrl}` : `WARNING: named tunnel NOT healthy: ${ep.apiUrl || '(none)'}`);
    log('done');
    return;
  }

  if (await healthy(ep.apiUrl)) {
    if (tunnelInLimbo(API_TUNNEL)) {
      // URL answers but cloudflared keeps retrying a dead registration —
      // this is the 21-hour crash-loop state; recycle before it rots.
      log('tunnel answers but cloudflared is in limbo (Tunnel not found) — recycling proactively');
      await recycle();
    } else {
      log(`tunnel healthy: ${ep.apiUrl}`);
    }
  } else {
    await recycle();
  }
  log('done');
}

main().catch((e) => { log(`FATAL ${e.stack || e}`); process.exit(1); });
