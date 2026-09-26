#!/usr/bin/env node
/**
 * /agent relay E2E — real telegram-monitor.js command loop against a local
 * mock Bot API, with agent-runner.runTask stubbed (same module object the
 * monitor uses), so no network calls to codebuff.com happen here.
 *
 * Verifies: /agent ack + background completion reply, /agent with no args →
 * usage, /agentstatus, busy-refusal while a run is in flight, and unknown
 * command still answered. Run: node scripts/test-agent-e2e.js
 */
const http = require('http');

const MOCK_PORT = 4631;
process.env.TELEGRAM_API_BASE = 'http://localhost:' + MOCK_PORT;
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHAT_ID = '424242';

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock Telegram Bot API (subset of telegram-e2e.js) ──────────────────
const sent = [];
let updates = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    const method = m && m[1];
    if (!m) { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); return; }
    if (method === 'sendMessage') {
      const j = JSON.parse(body);
      sent.push(j.text);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: j.chat_id }, text: j.text, date: Math.floor(Date.now() / 1000) } }));
    } else if (method === 'getUpdates') {
      const j = JSON.parse(body);
      const queue = updates; updates = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: queue.map((text, i) => ({ update_id: (j.offset || 0) + 1 + i, message: { message_id: 900 + i, from: { id: 424242, first_name: 'Rishi' }, chat: { id: 424242 }, date: Math.floor(Date.now() / 1000), text } })) }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); }
  });
});

// ── stub agent-runner BEFORE telegram-monitor requires it ──────────────
const runnerStub = require('../agent-runner');
let releaseRun = null;
// Mimic the real runner: `running` flips synchronously inside runTask.
runnerStub.runTask = async (task) => {
  runnerStub.__running = true;
  try {
    await new Promise((r) => { releaseRun = r; });
    return { ok: true, text: '🤖 fake done: ' + task, durationMs: 1234 };
  } finally { runnerStub.__running = false; }
};
runnerStub.__running = false;
runnerStub.status = () => ({ enabled: true, model: 'stub-model', running: runnerStub.__running, startedAt: new Date().toISOString(), lastTask: 'stub', lastFinishedAt: null, lastOk: null, lastDurationMs: null, lastError: null, runs: 0, failed: 0 });

(async () => {
  await new Promise((r) => server.listen(MOCK_PORT, r));
  const tmon = require('../telegram-monitor');
  tmon.startCommands({ getSnapshot: () => ({}) });

  // 1 — /agent with a task: ack now, completion later (background)
  updates = ['/agent list all TODO comments in server.js'];
  await sleep(1600);
  t(sent.some((s) => s.startsWith('🚀 Agent on it — "list all TODO comments')), '/agent ack sent', JSON.stringify(sent));
  t(!sent.some((s) => s.startsWith('🤖 fake done')), 'completion not yet sent (run still in flight)');

  // 2 — second /agent while busy is refused
  updates = ['/agent second task'];
  await sleep(1200);
  t(sent.some((s) => s.includes('Already working on')), 'busy refusal while run in flight', JSON.stringify(sent));

  // let run 1 finish → completion message should land
  releaseRun();
  await sleep(1200);
  t(sent.some((s) => s.startsWith('🤖 fake done: list all TODO comments')), 'background completion delivered', JSON.stringify(sent));

  // 3 — /agent with no args → usage
  updates = ['/agent'];
  await sleep(1200);
  t(sent.some((s) => s.startsWith('Usage: /agent')), 'no-arg /agent replies with usage');

  // 4 — /agentstatus shows the stubbed runner
  updates = ['/agentstatus'];
  await sleep(1200);
  t(sent.some((s) => s.includes('Agent runner — model stub-model')), '/agentstatus reports runner info');

  // 5 — other commands unaffected
  updates = ['/nonsense'];
  await sleep(1200);
  t(sent.some((s) => s.includes('Unknown command /nonsense')), 'unknown command path unchanged');

  tmon.stop();
  server.close();
  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('E2E crash:', e); process.exit(1); });
