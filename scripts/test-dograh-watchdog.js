#!/usr/bin/env node
/**
 * dograh-watchdog unit test — real watchdog logic, FAKE docker + FAKE fetch.
 * No containers touched, no git runs, no network. Endpoints use
 * trycloudflare-shaped URLs; global.fetch is intercepted so only the fake
 * "healthy" URL answers.
 *
 * Verifies: healthy → no-op; healthy-but-limbo → recycle; dead → recycle +
 * rewrite + .env sync; URL-unchanged → no commit; named mode → observe-only.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let ok = true;
const realLog0 = console.log.bind(console);
const t = (pass, label, extra) => { realLog0((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

// ── sandbox: real watchdog copied in so writes are isolated ────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-wd-'));
fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(sandbox, 'public'), { recursive: true });
const WD = path.join(sandbox, 'scripts', 'dograh-watchdog.js');
fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'dograh-watchdog.js'), WD);
const EP = path.join(sandbox, 'public', 'dograh-endpoints.json');
const ENVF = path.join(sandbox, '.env');
const writeEp = (j) => fs.writeFileSync(EP, JSON.stringify(j, null, 2) + '\n');

// ── fake docker/git shim ───────────────────────────────────────────────
let containerLogs = { 'cloudflared-tunnel': '', 'dograh-ui-tunnel': '' };
let restarts = 0;
let retires = 0;
child_fix: {
  const child = require('child_process');
  child.execSync = function fakeSh(cmd) {
    const c = String(cmd);
    if (c.startsWith('docker logs cloudflared-tunnel')) return containerLogs['cloudflared-tunnel'];
    if (c.startsWith('docker logs dograh-ui-tunnel')) return containerLogs['dograh-ui-tunnel'];
    if (c.startsWith('docker restart')) { restarts++; return ''; }
  if (c.startsWith('docker rm -f')) { retires++; return ''; }
    if (c.startsWith('git ')) return '';
    throw new Error('unexpected sh: ' + c);
  };
}

const GOOD_API = 'https://fresh-api-123.trycloudflare.com';
const GOOD_UI = 'https://fresh-ui-456.trycloudflare.com';
const PERM_API = 'https://voice.example.org';
const PERM_UI = 'https://voice-ui.example.org';
const HEALTHY = new Set([GOOD_API, PERM_API]);
const realFetch = global.fetch;
global.fetch = async (url) => ([...HEALTHY].some((u) => String(url).startsWith(u)) ? { ok: true } : Promise.reject(new Error('connect ECONNREFUSED dead')));

function banner(url) {
  return url
    ? `2026-09-27T00:00:00Z INF +---------------------------------------------------------------------------+\n|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n|  ${url}  |\n+---------------------------------------------------------------------------+`
    : 'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"';
}
function regLogs(api, ui) {
  containerLogs['cloudflared-tunnel'] = banner(api);
  containerLogs['dograh-ui-tunnel'] = banner(ui);
}

process.chdir(sandbox);
process.env.WATCHDOG_TIMEOUT_MS = '3000';
const logs = [];
const realLog = console.log.bind(console);
console.log = (...a) => logs.push(a.join(' '));

function runFresh() {
  logs.length = 0;
  return new Promise((resolve, reject) => {
    delete require.cache[require.resolve(WD)];
    const origExit = process.exit;
    process.exit = (c) => { throw new Error('EXIT:' + c); };
    try { require(WD); } catch (e) { process.exit = origExit; return reject(e); }
    process.exit = origExit;
    const iv = setInterval(() => {
      if (logs.some((l) => l.includes('] done'))) { clearInterval(iv); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(iv); reject(new Error('timeout waiting for done; logs: ' + logs.join(' | ').slice(0, 300))); }, 60000);
  });
}

(async () => {
  // 1 — healthy tunnel, no limbo → pure no-op
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  await runFresh();
  t(restarts === 0, 'healthy → zero restarts', 'restarts=' + restarts);
  t(!logs.join(' ').includes('recycl'), 'healthy → no recycle');

  // 2 — healthy but limbo → proactive recycle; same URLs → file untouched
  containerLogs['cloudflared-tunnel'] += '\n' + banner(null);
  const before = fs.readFileSync(EP, 'utf8');
  await runFresh();
  t(restarts === 1, 'limbo → proactive recycle (one restart cmd, both containers)', 'restarts=' + restarts);
  t(fs.readFileSync(EP, 'utf8') === before, 'URLs unchanged → endpoints file untouched (no-op guard)');

  // 3 — dead URL → recycle mints new URLs, rewrites file + creates .env
  writeEp({ token: 'emb_x', uiUrl: 'https://stale-one.trycloudflare.com', apiUrl: 'https://stale-api.trycloudflare.com', updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  await runFresh();
  const ep = JSON.parse(fs.readFileSync(EP, 'utf8'));
  t(ep.apiUrl === GOOD_API && ep.uiUrl === GOOD_UI, 'dead → endpoints rewritten to new URLs', JSON.stringify(ep));
  t(fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_API_URL=' + GOOD_API), '.env created + synced with new api url');

  // 4 — named mode: dead URL + limbo logs → observe only, zero new restarts
  // (apiUrl must NOT be trycloudflare, so the one-time transition branch is skipped)
  const r0 = restarts;
  process.env.DOGRAH_TUNNEL_MODE = 'named';
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: 'https://dead-named.example.org', updatedAt: 'x' });
  regLogs(null, null);
  await runFresh();
  t(restarts === r0, 'named mode → observe-only (no restarts)');
  t(logs.join(' ').includes('named tunnel NOT healthy'), 'named mode reports unhealthy');
  process.env.DOGRAH_TUNNEL_MODE = 'quick';

  // 5 — one-time transition: quick-tunnel endpoints + live perm URL → flip everything
  process.env.DOGRAH_PERM_API = PERM_API;
  process.env.DOGRAH_PERM_UI = PERM_UI;
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' });
  await runFresh();
  const ep5 = JSON.parse(fs.readFileSync(EP, 'utf8'));
  t(ep5.apiUrl === PERM_API && ep5.uiUrl === PERM_UI, 'transition: endpoints flipped to permanent URLs', JSON.stringify(ep5));
  t(fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_TUNNEL_MODE=named') && fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_API_URL=' + PERM_API), 'transition: .env gets perm URLs + named mode');
  t(retires === 1, 'transition: quick-tunnel containers retired', 'retires=' + retires);
  delete process.env.DOGRAH_PERM_API;
  delete process.env.DOGRAH_PERM_UI;

  global.fetch = realFetch;
  console.log = realLog;
  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('UNIT crash:', e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n')); process.exit(1); });
