#!/usr/bin/env node
// dograh-watchdog.js — keeps the site's free line working 24/7.
//
// The Dograh stack runs on this PC behind trycloudflare quick tunnels whose
// URLs rotate whenever the tunnels restart. The live site learns the current
// URLs from public/dograh-endpoints.json (tracked in git, deployed to Render).
// This script, run every few minutes by Windows Task Scheduler:
//   1. health-checks the API tunnel URL from the endpoints file
//   2. if dead: restarts the tunnel containers and reads the new URLs
//   3. rewrites public/dograh-endpoints.json
//   4. commits + pushes so Render auto-deploys the fresh URLs
// Also writes .env (DOGRAH_API_URL/DOGRAH_UI_URL) so the local site agrees.
//
// Env/config (defaults fine): DOGRAH_REPO_DIR, DOGRAH_BRANCH, WATCHDOG_TIMEOUT_MS
// Run manually: node scripts/dograh-watchdog.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRANCH = process.env.DOGRAH_BRANCH || 'main';
const TIMEOUT = process.env.WATCHDOG_TIMEOUT_MS || '20000';
const FILE = path.join(ROOT, 'public', 'dograh-endpoints.json');
const ENVFILE = path.join(ROOT, '.env');

const API_TUNNEL = 'cloudflared-tunnel';
const UI_TUNNEL = 'dograh-ui-tunnel';

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

async function main() {
  let ep = readEndpoints();
  const was = ep.apiUrl || '(none)';
  let changed = false;

  if (await healthy(ep.apiUrl)) {
    log(`tunnel healthy: ${ep.apiUrl}`);
  } else {
    log(`tunnel DEAD (${was}) — restarting tunnels`);
    try { sh(`docker restart ${API_TUNNEL} ${UI_TUNNEL}`); } catch (e) { log(`restart failed: ${e.message}`); }
    // quick tunnels print their hostname a few seconds after boot
    await new Promise((r) => setTimeout(r, 15000));
    const api = tunnelUrl(API_TUNNEL, '--since 2m');
    const ui = tunnelUrl(UI_TUNNEL, '--since 2m');
    if (!api || !ui) { log('ERROR: no new tunnel URLs in logs — giving up this run'); process.exit(1); }
    ep = { ...ep, token: ep.token || '', uiUrl: ui, apiUrl: api, updatedAt: new Date().toISOString() };
    if (!ep.token) { log('ERROR: endpoints file had no token; not overwriting'); process.exit(1); }
    fs.writeFileSync(FILE, JSON.stringify(ep, null, 2) + '\n');
    // keep local .env in sync for the local server
    try {
      let env = fs.readFileSync(ENVFILE, 'utf8');
      const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + `\n${k}=${v}`; };
      set('DOGRAH_API_URL', api); set('DOGRAH_UI_URL', ui);
      fs.writeFileSync(ENVFILE, env);
    } catch (e) { /* .env optional */ }
    changed = true;
    log(`new URLs: api=${api} ui=${ui} — verifying`);
    await new Promise((r) => setTimeout(r, 5000));
    if (!(await healthy(api))) log('WARNING: new API tunnel not healthy yet (may need another cycle)');
  }

  if (changed) {
    try {
      sh('git add public/dograh-endpoints.json');
      sh(`git commit -m "chore: refresh Dograh tunnel endpoints (watchdog)"`);
      sh(`git push origin ${BRANCH}`);
      log('pushed — Render will auto-deploy the new endpoints');
    } catch (e) {
      log(`git push failed: ${String(e.message).slice(0, 200)} (file updated locally; will retry next run)`);
    }
  }
  log('done');
}

main().catch((e) => { log(`FATAL ${e.stack || e}`); process.exit(1); });
