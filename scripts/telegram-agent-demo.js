#!/usr/bin/env node
/**
 * Telegram /agent dry-run — runs the REAL telegram-monitor command loop
 * against a mock Bot API with the REAL agent-runner (free OpenRouter brain),
 * then prints exactly what your chat would receive, in order.
 *
 * Usage: node scripts/telegram-agent-demo.js "<task>"
 * (no Telegram token needed — nothing leaves this PC except model calls)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// load .env like server.js does (OPENROUTER_API_KEY etc.)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const task = process.argv.slice(2).join(' ') || 'list all TODO and FIXME comments in server.js';
const sent = [];
let queued = [{ text: '/agent ' + task }];

const mock = http.createServer((req, res) => {
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

mock.listen(0, () => {
  process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:' + mock.address().port;
  process.env.TELEGRAM_BOT_TOKEN = 'DEMO:TOKEN';
  process.env.TELEGRAM_CHAT_ID = '424242';
  const tmon = require('../telegram-monitor');
  tmon.startCommands({ getSnapshot: () => ({}) });

  const t0 = Date.now();
  const seen = new Set();
  const iv = setInterval(() => {
    for (const m of sent) {
      if (!seen.has(m)) { seen.add(m); console.log('💬 ' + m.split('\n')[0].slice(0, 90)); }
    }
    if (sent.some((s) => s.startsWith('🤖') || s.startsWith('❌'))) {
      clearInterval(iv);
      tmon.stop(); mock.close();
      console.log('\n════════ WHAT TELEGRAM WOULD SHOW ════════\n');
      for (const m of sent) console.log(m + '\n' + '─'.repeat(46));
      console.log('\n(live run: ' + Math.round((Date.now() - t0) / 1000) + 's total)');
      process.exit(0);
    }
    if (Date.now() - t0 > 540000) { console.log('TIMEOUT — messages seen:', JSON.stringify(sent).slice(0, 300)); process.exit(1); }
  }, 500);
});
