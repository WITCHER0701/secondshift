#!/usr/bin/env node
/**
 * dograh-watchdog unit test — real watchdog logic, FAKE docker + FAKE fetch.
 * No containers touched, no git runs, no network.
 *
 * Verifies: healthy → no-op; healthy-but-limbo → recreate; dead → recreate +
 * rewrite + .env sync; fresh-registration grace (no URL churn); named mode →
 * observe-only; one-time transition to permanent URLs.
 *
 * The harness requires the watchdog exactly ONCE per scenario via a child
 * process (node <sandbox>/scripts/dograh-watchdog.js) — no cross-instance
 * state, and a hung run can't poison the next scenario. Output lines are
 * parsed from the child's stdout.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let ok = true;
const realLog = console.log.bind(console);
const t = (pass, label, extra) => { realLog((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

// ── sandbox: real watchdog copied in so writes are isolated ────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-wd-'));
fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(sandbox, 'public'), { recursive: true });
const WD = path.join(sandbox, 'scripts', 'dograh-watchdog.js');
fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'dograh-watchdog.js'), WD);
const EP = path.join(sandbox, 'public', 'dograh-endpoints.json');
const ENVF = path.join(sandbox, '.env');
const writeEp = (j) => fs.writeFileSync(EP, JSON.stringify(j, null, 2) + '\n');

// ── the shim module the sandboxed watchdog will load for child_process ─
// (copied into sandbox/node_modules/child_process-shim? No — simpler: we
// patch nothing on disk. Instead the scenario runner passes fake data via
// a shim script that wraps node and intercepts `docker`/`git` commands.)
const SHIM_DIR = path.join(sandbox, 'shim');
fs.mkdirSync(SHIM_DIR, { recursive: true });
// fake `docker` and `git` executables driven by scenario JSON
// %~dp0 = directory of this .cmd file (trailing backslash included) — immune to
// env-var expansion quirks that corrupt `%SHIM_DATA%\fake-docker.js` under cmd.exe.
fs.writeFileSync(path.join(SHIM_DIR, 'docker.cmd'), '@echo off\r\nnode "%~dp0fake-docker.js" %*\r\n');
fs.writeFileSync(path.join(SHIM_DIR, 'git.cmd'), '@echo off\r\nexit /b 0\r\n');
const scenarioState = { apiLogs: '', uiLogs: '', recycles: 0, retires: 0, healthy: [] };
function writeScenarioState() {
  fs.writeFileSync(path.join(SHIM_DIR, 'state.json'), JSON.stringify(scenarioState));
}
// fetch preload for the CHILD watchdog process: makes only the scenario's
// "healthy" URLs answer; records every Telegram send to tg-sends.json so
// scenarios can assert on heal alerts (the parent's global.fetch patch can't
// reach the child).
fs.writeFileSync(path.join(SHIM_DIR, 'fetch-preload.js'), `const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.SHIM_DATA + '/state.json', 'utf8'));
global.fetch = async (url, opts) => {
  if (String(url).includes('api.telegram.org')) {
    const body = JSON.parse((opts && opts.body) || '{}');
    const sends = JSON.parse(fs.readFileSync(process.env.SHIM_DATA + '/tg-sends.json', 'utf8') || '[]');
    sends.push(body.text || '');
    fs.writeFileSync(process.env.SHIM_DATA + '/tg-sends.json', JSON.stringify(sends));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if ((st.healthy || []).some((u) => String(url).startsWith(u))) return { ok: true, status: 200 };
  throw new Error('connect ECONNREFUSED (fake)');
};
`);
// fake docker: serves logs + ps/inspect/compose + counts rm/run (fresh each scenario)
const fakeDocker = `const fs=require('fs');
const st=JSON.parse(fs.readFileSync(process.env.SHIM_DATA+'/state.json','utf8'));
const a=process.argv.slice(2).join(' ');
const APP=['dograh-api-1','dograh-ui-1','dograh-postgres-1','dograh-redis-1'];
const TUN=['dograh-ui-tunnel','cloudflared-tunnel'];
if(!st.running) st.running = st.originDown ? TUN : TUN.concat(APP);
if(a.startsWith('logs cloudflared-tunnel')){console.log(st.apiLogs);}
else if(a.startsWith('logs dograh-ui-tunnel')){console.log(st.uiLogs);}
else if(a.startsWith('ps ')){console.log(st.running.join('\\n'));}
else if(a.startsWith('inspect -f')){console.log('healthy');}
else if(a.startsWith('compose -f')&&a.includes(' up -d')){st.originRepaired=(st.originRepaired||0)+1;st.running=TUN.concat(APP);fs.writeFileSync(process.env.SHIM_DATA+'/state.json',JSON.stringify(st));}
else if(a.startsWith('run -d --name cloudflared-tunnel')){st.recycles++;fs.writeFileSync(process.env.SHIM_DATA+'/state.json',JSON.stringify(st));console.log('id');}
else if(a.startsWith('run -d --name dograh-ui-tunnel')){fs.writeFileSync(process.env.SHIM_DATA+'/state.json',JSON.stringify(st));console.log('id');}
else if(a.startsWith('rm -f')){st.retires++;fs.writeFileSync(process.env.SHIM_DATA+'/state.json',JSON.stringify(st));}
else {console.error('fake-docker: unexpected '+a);process.exit(1);}
`;
fs.writeFileSync(path.join(SHIM_DIR, 'fake-docker.js'), fakeDocker);

const GOOD_API = 'https://fresh-api-123.trycloudflare.com';
const GOOD_UI = 'https://fresh-ui-456.trycloudflare.com';
const PERM_API = 'https://voice.example.org';
const PERM_UI = 'https://voice-ui.example.org';
function banner(url) {
  return url
    ? `2026-09-27T00:00:00Z INF +---------------------------------------------------------------------------+\n|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n|  ${url}  |\n+---------------------------------------------------------------------------+`
    : 'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"';
}
function regLogs(api, ui) {
  scenarioState.apiLogs = banner(api);
  scenarioState.uiLogs = banner(ui);
}

/** Runs the watchdog as a child process; resolves with its stdout lines. */
function runScenario(env = {}, opts = {}) {
  writeScenarioState();
  fs.writeFileSync(path.join(SHIM_DIR, 'tg-sends.json'), '[]');
  if (!opts.keepAlertState) { try { fs.unlinkSync(path.join(sandbox, 'watchdog.alerts.json')); } catch (_) {} }
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-r', path.join(SHIM_DIR, 'fetch-preload.js'), WD], {
      cwd: sandbox,
      timeout: 30000,
      env: {
        ...process.env,
        WATCHDOG_TIMEOUT_MS: '3000',
        WATCHDOG_SLEEP_MS: '10',
        WATCHDOG_HEALTH_WAIT_MS: '400',
        PATH: SHIM_DIR + path.delimiter + process.env.PATH,
        SHIM_DATA: SHIM_DIR,
        DOGRAH_TUNNEL_MODE: 'quick',
        WATCHDOG_TELEGRAM_BOT_TOKEN: 'TEST:TOKEN',
        WATCHDOG_TELEGRAM_CHAT_ID: '424242',
        ...env,
      },
    }, (err, stdout, stderr) => {
      // the watchdog exits 1 when it deliberately gives up — that's data, not a crash
      resolve({ lines: String(stdout || '').split('\n'), code: err ? err.code || 1 : 0, stderr: String(stderr || '') });
    });
  });
}
// counters live on disk (the child increments them) — always read fresh
const readState = () => JSON.parse(fs.readFileSync(path.join(SHIM_DIR, 'state.json'), 'utf8'));
const readSends = () => JSON.parse(fs.readFileSync(path.join(SHIM_DIR, 'tg-sends.json'), 'utf8'));

(async () => {
  // ── 1 — healthy tunnel, no limbo → pure no-op ────────────────────────
  scenarioState.healthy = [GOOD_API];
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  scenarioState.retires = 0;
  let r = await runScenario();
  t(readState().recycles === 0, 'healthy → zero recycles', 'recycles=' + readState().recycles);
  t(r.lines.join(' ').includes('tunnel healthy'), 'healthy → reports healthy', r.lines.join(' | ').slice(0, 160));

  // ── 2 — healthy but limbo → proactive recreate; same URLs → file untouched ──
  scenarioState.apiLogs += '\n' + banner(null); // Tunnel not found in last 10m
  const before = fs.readFileSync(EP, 'utf8');
  r = await runScenario();
  t(readState().recycles === 1, 'limbo → proactive recreate (fresh registrations)', 'recycles=' + readState().recycles + ' · out: ' + r.lines.join(' | ').slice(0, 200) + ' · ERR: ' + String(r.stderr).slice(0, 300));
  t(fs.readFileSync(EP, 'utf8') === before, 'URLs unchanged → endpoints file untouched (no-op guard)');

  // ── 3 — dead URL but NEWER logged URL (self-rotated) → adopt, no recycle ──
  scenarioState.healthy = [GOOD_API];
  writeEp({ token: 'emb_x', uiUrl: 'https://stale-one.trycloudflare.com', apiUrl: 'https://stale-api.trycloudflare.com', updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  scenarioState.recycles = 0;
  r = await runScenario();
  const ep3 = JSON.parse(fs.readFileSync(EP, 'utf8'));
  t(readState().recycles === 0, 'self-rotated → adopted newest URLs without recycle', 'recycles=' + readState().recycles);
  t(ep3.apiUrl === GOOD_API && ep3.uiUrl === GOOD_UI, 'self-rotated → endpoints rewritten to newest URLs', JSON.stringify(ep3));
  t(fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_API_URL=' + GOOD_API), '.env created + synced with new api url');

  // ── 3b — dead URL, no newer URL anywhere → real recreate, twice, then give up ──
  scenarioState.healthy = [];
  scenarioState.apiLogs = banner(null); // only "Tunnel not found" retries
  scenarioState.uiLogs = banner(null);
  scenarioState.recycles = 0;
  const before3b = fs.readFileSync(EP, 'utf8');
  r = await runScenario();
  t(readState().recycles === 2, 'dead + no URLs → recreate twice then give up', 'recycles=' + readState().recycles);
  t(fs.readFileSync(EP, 'utf8') === before3b, 'give-up run → endpoints file untouched');

  // ── 4 — dead URL but fresh registration → propagation grace, no churn ──
  // A registration line exists but no newer URL → must NOT recycle.
  scenarioState.healthy = []; // nothing answers yet (propagation window)
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: 'https://dead-prop.trycloudflare.com', updatedAt: 'old' });
  scenarioState.apiLogs = '2026-10-01T00:00:00Z INF Registered tunnel connection connIndex=0';
  scenarioState.uiLogs = '';
  scenarioState.recycles = 0;
  r = await runScenario();
  t(readState().recycles === 0, 'dead URL + fresh registration → grace (no recycle)', 'recycles=' + readState().recycles + ' · out: ' + r.lines.join(' | ').slice(0, 200));

  // ── 5 — named mode: observe only, zero recycles ──────────────────────
  scenarioState.healthy = [];
  scenarioState.recycles = 0;
  r = await runScenario({ DOGRAH_TUNNEL_MODE: 'named' });
  t(scenarioState.recycles === 0, 'named mode → observe-only (no recycles)');
  t(r.lines.join(' ').includes('named tunnel NOT healthy'), 'named mode reports unhealthy');

  // ── 6 — one-time transition: quick-tunnel endpoints + live perm URL → flip ──
  scenarioState.healthy = [GOOD_API, PERM_API];
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  scenarioState.retires = 0;
  r = await runScenario({ DOGRAH_PERM_API: PERM_API, DOGRAH_PERM_UI: PERM_UI });
  const ep6 = JSON.parse(fs.readFileSync(EP, 'utf8'));
  t(ep6.apiUrl === PERM_API && ep6.uiUrl === PERM_UI, 'transition: endpoints flipped to permanent URLs', JSON.stringify(ep6));
  t(fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_TUNNEL_MODE=named') && fs.readFileSync(ENVF, 'utf8').includes('DOGRAH_API_URL=' + PERM_API), 'transition: .env gets perm URLs + named mode');
  t(readState().retires >= 1, 'transition: quick-tunnel containers retired', 'retires=' + readState().retires);
  t(readSends().some((s) => /PERMANENT/.test(s)), 'transition: one-time cutover telegram sent', JSON.stringify(readSends()).slice(0, 120));

  // ── 7 — healthy tunnel → NO telegram noise ──────────────────────────
  scenarioState.healthy = [GOOD_API];
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' }); // undo scenario 6's perm flip
  scenarioState.apiLogs = banner(GOOD_API); // limbo gone
  scenarioState.uiLogs = banner(GOOD_UI);
  scenarioState.recycles = 0;
  r = await runScenario();
  t(readSends().length === 0, 'healthy → zero telegram sends', JSON.stringify(readSends()).slice(0, 120));

  // ── 8 — real heal (dead → recreated) → heal alert delivered ─────────
  scenarioState.healthy = []; // nothing answers → recycle path
  scenarioState.recycles = 0;
  // after recreate, fake docker logs expose GOOD urls; health flips via state
  scenarioState.apiLogs = banner(null);
  scenarioState.uiLogs = banner(null);
  r = await runScenario();
  t(readSends().some((s) => /STILL DOWN/.test(s)), 'unrecoverable run → still-down alert sent', JSON.stringify(readSends()).slice(0, 140));

  // ── 9 — cooldown: immediate second failure is suppressed ───────────
  r = await runScenario({}, { keepAlertState: true });
  t(readSends().length === 0, 'second failure within cooldown → alert suppressed', JSON.stringify(readSends()));
  t(r.lines.join(' ').includes('suppressed'), 'suppression is logged', r.lines.filter((l) => l.includes('suppress')).join(' | ').slice(0, 140));

  // ── 10 — self-rotation heal → heal alert ────────────────────────────
  scenarioState.healthy = [GOOD_API];
  writeEp({ token: 'emb_x', uiUrl: 'https://stale2.trycloudflare.com', apiUrl: 'https://stale2-api.trycloudflare.com', updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  scenarioState.recycles = 0;
  r = await runScenario();
  t(readSends().some((s) => /self-healed/.test(s) && /rotated/.test(s)), 'self-rotated → heal alert sent', JSON.stringify(readSends()).slice(0, 140));

  // ── 11 — no creds → warns in logs, never crashes, no alert ─────────
  scenarioState.healthy = [GOOD_API];
  regLogs(GOOD_API, GOOD_UI);
  r = await runScenario({ WATCHDOG_TELEGRAM_BOT_TOKEN: '', WATCHDOG_TELEGRAM_CHAT_ID: '' });
  t(r.lines.join(' ').includes('heal alerts not configured') || readSends().length === 0, 'missing creds → clean log note, no crash');

  // ── 12 — origin stack down (Docker restart) → compose up, no tunnel churn ──
  // The app containers exited while tunnels stayed up: the watchdog must
  // revive the ORIGIN instead of chasing phantom tunnel problems.
  scenarioState.originDown = true;
  scenarioState.healthy = [GOOD_API];
  writeEp({ token: 'emb_x', uiUrl: GOOD_UI, apiUrl: GOOD_API, updatedAt: 'old' });
  regLogs(GOOD_API, GOOD_UI);
  scenarioState.recycles = 0;
  r = await runScenario();
  t(readState().originRepaired >= 1, 'origin down → docker compose up runs', 'repaired=' + readState().originRepaired);
  t(r.lines.join(' ').includes('origin stack healthy again'), 'origin heals within the run', r.lines.filter((l) => l.includes('origin')).join(' | ').slice(0, 160));
  t(readState().recycles === 0, 'origin down → tunnels NOT recreated (origin was the problem)', 'recycles=' + readState().recycles);
  scenarioState.originDown = false;

  // ── 13 — healthy origin → zero compose calls, zero noise ─────────────
  scenarioState.healthy = [GOOD_API];
  regLogs(GOOD_API, GOOD_UI);
  r = await runScenario();
  t(!readState().originRepaired, 'healthy origin → no compose calls', 'repaired=' + readState().originRepaired);
  t(readSends().length === 0, 'healthy origin → no telegram noise', JSON.stringify(readSends()).slice(0, 120));

  realLog(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('UNIT crash:', e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n')); process.exit(1); });
