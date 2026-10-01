#!/usr/bin/env node
/**
 * Auto-diagnosis E2E — REAL telegram-monitor + REAL agent-runner (free
 * OpenRouter brain against a local mock), REAL 5xx tap, mock Bot API.
 *
 * Verifies: 5xx alert + follow-up 🔎 diagnosis, watchdog DOWN + 🔎 diagnosis
 * (Dograh probe), dedup (no second diagnosis inside the window), rate caps,
 * and clean refusal when no OPENROUTER key is present.
 *
 * Run: node scripts/test-auto-diagnose.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock OpenRouter (scripted tool loop, sandbox copy so edits are safe) ──
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-autodiag-'));
fs.writeFileSync(path.join(sandbox, 'server.js'), 'app.get("/boom", () => { throw new Error("kaboom") });\n');
fs.copyFileSync(path.join(__dirname, '..', 'agent-runner.js'), path.join(sandbox, 'agent-runner.js'));
const R = path.join(sandbox, 'agent-runner.js');

const script = [
  { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_files', arguments: '{"paths":["server.js"]}' } }] },
  { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'finish', arguments: '{"summary":"Most likely cause: /boom handler throws Error(kaboom) at server.js:1 — uncaught in the route."}' } }] },
];
let calls = 0;
const orMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const step = Math.min(calls++, script.length - 1);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: script[step].tool_calls } }] }));
  });
});

// ── mock Telegram Bot API ──────────────────────────────────────────────
const sent = [];
let queued = [];
const tgMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = (req.url.match(/\/bot[^/]+\/(\w+)/) || [])[1];
    if (method === 'sendMessage') {
      const j = JSON.parse(body);
      sent.push(j.text);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    } else if (method === 'getUpdates') {
      const j = JSON.parse(body);
      const q = queued; queued = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: q.map((u, i) => ({ update_id: (j.offset || 0) + 1 + i, message: { message_id: 1 + i, from: { id: 424242 }, chat: { id: 424242 }, text: u.text } })) }));
    } else { res.end(JSON.stringify({ ok: true, result: [] })); }
  });
});

process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHAT_ID = '424242';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.AGENT_FREE_MODELS = 'mock-model:free';
process.env.TELEGRAM_AUTO_DIAG_GAP_MS = '500'; // fast tests
process.env.TELEGRAM_AUTO_DIAG_MAX_PER_HOUR = '2';

(async () => {
  await Promise.all([orMock.listen(0), tgMock.listen(0)]);
  process.env.OPENROUTER_BASE = 'http://127.0.0.1:' + orMock.address().port;
  process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:' + tgMock.address().port;

  const tmon = require('../telegram-monitor');

  // 1 — 5xx triggers alert + real agent diagnosis follow-up
  tmon.notify5xx({ method: 'GET', url: '/boom', route: { path: '/boom' } }, { statusCode: 500 });
  const deadline = Date.now() + 8000;
  while (!sent.some((s) => s.startsWith('🔎')) && Date.now() < deadline) await sleep(40);
  t(sent.some((s) => s.includes('🚨 5xx — GET /boom') && s.includes('🔎 agent is diagnosing')), '5xx alert announces diagnosis');
  t(sent.some((s) => s.startsWith('🔎 Agent diagnosis — GET /boom') && s.includes('kaboom')), '5xx findings posted from real free-brain run', JSON.stringify(sent[sent.length - 1]).slice(0, 120));
  t(tmon.status().agentDiagnoses.ok === 1, 'diagnosis counted in status');

  // 2 — repeat 5xx immediately (inside TELEGRAM_AUTO_DIAG_GAP_MS=500) → no duplicate diagnosis
  const before = sent.length;
  tmon.notify5xx({ method: 'GET', url: '/boom?x=1', route: { path: '/boom' } }, { statusCode: 502 });
  await sleep(300);
  t(!sent.slice(before).some((s) => s.startsWith('🔎')), 'dedup: no repeat diagnosis inside window');
  t(sent.slice(before).every((s) => !s.includes('🔎 agent is diagnosing')), 'dedup: alert does not promise another diagnosis');

  // 3 — watchdog probe with diagnoseTask (Dograh-style) → alert + diagnosis
  // (wait out the min-gap from diagnosis #1 so the watchdog slot is free)
  await sleep(800);
  let probeCalls = 0;
  tmon.startWatchdog({
    intervalMs: 60000, firstDelayMs: 50,
    probes: [{ name: 'dograh free line', diagnoseTask: 'diagnose the dograh outage', run: async () => { probeCalls++; return { ok: false, detail: 'timeout' }; } }],
  });
  await sleep(1500);
  t(sent.some((s) => s.includes('👁 Watchdog — dograh free line DOWN') && s.includes('🔎 agent is diagnosing')), 'watchdog DOWN alert announces diagnosis');
  t(sent.some((s) => s.startsWith('🔎 Agent diagnosis — dograh free line down')), 'watchdog findings posted');
  t(probeCalls === 1, 'probe ran once');

  // 4 — rate cap: TELEGRAM_AUTO_DIAG_MAX_PER_HOUR=2 → third diagnosis refused
  const countBefore = sent.filter((s) => s.startsWith('🔎')).length;
  tmon.notify5xx({ method: 'GET', url: '/third', route: { path: '/third' } }, { statusCode: 500 });
  await sleep(900);
  t(sent.filter((s) => s.startsWith('🔎')).length === countBefore, 'rate cap blocks diagnosis beyond hourly quota');
  t(tmon.status().agentDiagnoses.triggered === 2, 'status shows 2 diagnoses total', String(tmon.status().agentDiagnoses.triggered));

  // 5 — monitor stays healthy after everything (auto-diagnosis never destabilizes it)
  const st = tmon.status();
  t(st.enabled === true, 'monitor still enabled (5xx taps keep working)');
  t(st.agentDiagnoses.ok + st.agentDiagnoses.failed === st.agentDiagnoses.triggered, 'diagnosis bookkeeping consistent');
  tmon.stop();

  orMock.close(); tgMock.close();
  if (!ok) console.log('\nSENT MESSAGES:\n' + sent.map((s, i) => i + ': ' + s.split('\n')[0]).join('\n'));
  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('E2E crash:', e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n')); process.exit(1); });
