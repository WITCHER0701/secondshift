#!/usr/bin/env node
/**
 * Fix-button E2E — boots the REAL server.js (which registers the real fix
 * handlers) against a local mock Bot API, then fires the exact callback_query
 * the Telegram "🔧 Fix: test-agent" button sends. Verifies:
 *   1. the button is routed to a registered handler (no "No fix registered"),
 *   2. the ack is INSTANT (fix buttons must never await the task),
 *   3. the real agent health ping completes (real OpenRouter call via .env),
 *   4. no misleading "npx codebuff login" advice ever reaches the chat.
 *
 * Run: node scripts/test-fix-button.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 4632;
const SERVER_PORT = 4322;
process.env.TELEGRAM_API_BASE = 'http://localhost:' + MOCK_PORT;
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHAT_ID = '424242';
process.env.PORT = String(SERVER_PORT);

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

// ── mock Telegram Bot API ──────────────────────────────────────────────
const sent = [];            // every sendMessage text, in order
let updates = [{
  update_id: 1,
  callback_query: {
    id: 'cb-test-agent-1',
    from: { id: 424242 },
    message: { chat: { id: 424242 } },
    data: 'fix:test-agent',
  },
}];
const answeredCallbacks = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    const method = m && m[1];
    if (!m) { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); return; }
    res.setHeader('content-type', 'application/json');
    if (method === 'sendMessage') {
      sent.push(JSON.parse(body).text);
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    } else if (method === 'getUpdates') {
      const j = JSON.parse(body);
      const queue = updates; updates = [];
      res.end(JSON.stringify({ ok: true, result: queue.map((u, i) => ({ ...u, update_id: (j.offset || 0) + 1 + i })) }));
    } else if (method === 'answerCallbackQuery') {
      answeredCallbacks.push(JSON.parse(body).callback_query_id);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.end(JSON.stringify({ ok: true, result: [] }));
    }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mock.listen(MOCK_PORT, () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => (childOut += d));
  child.stderr.on('data', (d) => (childOut += d));
  child.on('exit', (code) => { if (code && code !== 0) { console.log('server exited early (code ' + code + ')'); console.log(childOut.slice(-800)); process.exit(1); } });

  const t0 = Date.now();
  let ackMs = null;
  const finish = (code) => { try { child.kill(); } catch (_) {} try { mock.close(); } catch (_) {} setTimeout(() => process.exit(code), 150); };

  (async () => {
    // wait for the server to boot and start polling the mock
    let booted = false;
    for (let i = 0; i < 40 && !booted; i++) { await sleep(500); booted = /\[monitor\]/.test(childOut); }
    if (!booted) { t(false, 'server booted with monitor enabled', childOut.slice(-300)); return finish(1); }
    t(true, 'server booted with Telegram monitor enabled');

    // wait for the instant ack + the real follow-up result (real OpenRouter call)
    let followUp = null;
    for (let i = 0; i < 180 && !followUp; i++) {
      await sleep(500);
      for (const s of sent) {
        if (/^🧪 Agent health ping dispatched/.test(s) && ackMs === null) ackMs = Date.now() - t0;
        if (/^(✅|❌) test-agent:/.test(s)) followUp = s;
      }
    }
    t(answeredCallbacks.includes('cb-test-agent-1'), 'button callback was answered (routed to a registered handler)');
    t(ackMs !== null, 'instant ack sent', ackMs !== null ? ackMs + 'ms after tap' : 'never arrived');
    t(ackMs === null || ackMs < 5000, 'ack is fast (button never awaits the task)', ackMs + 'ms');
    t(!!followUp, 'real health-ping follow-up arrived', followUp ? '' : '(none within 90s)');
    if (followUp) console.log('      ' + followUp.split('\n')[0].slice(0, 140));
    t(!followUp || /^✅ test-agent:/.test(followUp), 'health ping succeeded via the relay');
    t(sent.every((s) => !/codebuff login/i.test(s)), 'no "codebuff login" advice anywhere in the chat');

    const agenthealthSent = sent.find((s) => /^🤖 /.test(s));
    t(!agenthealthSent || /openrouter/.test(agenthealthSent), 'backend is openrouter (free models)');
    console.log('---- chat transcript ----');
    for (const s of sent) console.log('  ' + s.split('\n').map((l) => l.trim()).join(' | ').slice(0, 150));
    return finish(ok ? 0 : 1);
  })().catch((e) => { console.log('harness error: ' + (e && e.message)); finish(1); });
});
