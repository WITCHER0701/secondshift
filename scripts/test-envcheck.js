#!/usr/bin/env node
/**
 * /envcheck test — the phone-side config audit.
 *
 * Part A unit-tests the formatter: set/missing/warning lines, server identity,
 * empty-string vars counting as missing, and — most importantly — that no env
 * VALUE ever reaches the chat.
 * Part B drives the REAL monitor against a mock Bot API to prove the command is
 * wired up and answers over the wire.
 *
 * Run: node scripts/test-envcheck.js
 */
const http = require('http');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The monitor snapshots token/chat id when it is required, so the mock must be
// configured first — Part A's formatter tests are unaffected by this.
const MOCK_PORT = 4633;
const SECRET = 'sk-or-v1-DONOTPRINTME';
process.env.TELEGRAM_API_BASE = 'http://localhost:' + MOCK_PORT;
process.env.TELEGRAM_BOT_TOKEN = '111:' + SECRET;
process.env.TELEGRAM_CHAT_ID = '424242';
process.env.OPENROUTER_API_KEY = SECRET;
delete process.env.VAPI_ASSISTANT_ID;

const tmon = require('../telegram-monitor');

// ── Part A — the formatter ─────────────────────────────────────────────
const full = tmon.formatEnvCheck({
  RENDER: 'true', RENDER_GIT_COMMIT: '3d7917eabcdef1234',
  TELEGRAM_BOT_TOKEN: '111:secret-token', TELEGRAM_CHAT_ID: '424242',
  ADMIN_PASSWORD: 'a-strong-one', SESSION_SECRET: 'another-strong-one',
  OPENROUTER_API_KEY: SECRET,
  VAPI_PUBLIC_KEY: 'pub-key', VAPI_ASSISTANT_ID: 'asst-id',
  CLOUD_GIST_TOKEN: 'gist-token', CLOUD_GIST_ID: 'gist-id',
}, { agent: { enabled: true, backend: 'openrouter', runs: 3, failed: 0 } });

t(/Env check/.test(full) && /Render/.test(full), 'names the server it answered from');
t(/commit 3d7917e/.test(full), 'shows the deployed commit', full.split('\n')[0]);
t(!/❌/.test(full) && !/missing/.test(full), 'fully configured server → no missing vars');
t(/everything required is present/.test(full), 'clean summary when nothing is missing');
t(/✅ OPENROUTER_API_KEY/.test(full), 'agent key reported as present');
t(/Agent: ✅ openrouter/.test(full), 'agent relay state included', (full.match(/Agent: .*/) || [''])[0]);

// the whole point: booleans only, never values
const leaked = [SECRET, 'secret-token', 'a-strong-one', 'gist-token', 'pub-key', 'asst-id'].filter((v) => full.includes(v));
t(leaked.length === 0, 'no env VALUE ever appears in the reply', leaked.join(', '));
t(!/sk-or-v1|111:/.test(full), 'no key/prefix fragments either');

// missing + warnings
const bare = tmon.formatEnvCheck({ RENDER: 'true' }, { agent: { enabled: false, backend: null, runs: 0, failed: 0 } });
t(/❌ OPENROUTER_API_KEY/.test(bare), 'missing agent key flagged with ❌');
t(/❌ TELEGRAM_BOT_TOKEN/.test(bare), 'missing bot token flagged');
t(/⚠️ ADMIN_PASSWORD/.test(bare) && !/❌ ADMIN_PASSWORD/.test(bare), 'admin password is a warning, not a failure');
t(/no cloud sync/.test(bare), 'no cloud sync surfaced as a warning');
t(/Render → your service → Environment/.test(bare), 'tells you where to fix it (Render)');
t(/❌ inactive/.test(bare), 'inactive agent relay surfaced');
t(/5 missing/.test(bare), 'counts the missing vars', (bare.match(/\d+ missing.*/) || [''])[0]);

// empty strings are missing, and the PC is identified as the PC
const pc = tmon.formatEnvCheck({ OPENROUTER_API_KEY: '   ', TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' }, {});
t(/this PC/.test(pc), 'local PC identified when RENDER is absent', pc.split('\n')[0]);
t(/❌ OPENROUTER_API_KEY/.test(pc), 'whitespace-only value counts as missing');
t(/\.env on this PC/.test(pc), 'PC remedy points at .env');

// ── Part B — wired into the real monitor, over the wire ────────────────
const sent = [];
let updates = [{ text: '/envcheck' }];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    res.setHeader('content-type', 'application/json');
    if (m && m[1] === 'sendMessage') { sent.push(JSON.parse(body).text); res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } })); }
    else if (m && m[1] === 'getUpdates') {
      const j = JSON.parse(body);
      const queue = updates; updates = [];
      res.end(JSON.stringify({ ok: true, result: queue.map((u, i) => ({ update_id: (j.offset || 0) + 1 + i, message: { message_id: 500 + i, from: { id: '424242' }, chat: { id: '424242' }, text: u.text } })) }));
    } else res.end(JSON.stringify({ ok: true, result: [] }));
  });
});

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, r));

  tmon.startCommands({ getSnapshot: () => ({}) });
  let got = null;
  for (let i = 0; i < 30 && !got; i++) { await sleep(400); got = sent.find((s) => /Env check/.test(s)); }

  t(!!got, '/envcheck answered through the real command loop');
  if (got) {
    t(/OPENROUTER_API_KEY/.test(got) && /VAPI_ASSISTANT_ID/.test(got), 'reply lists the checked vars', got.split('\n')[0]);
    t(!got.includes(SECRET), 'no secret value in the delivered message');
    t(/❌ VAPI_ASSISTANT_ID/.test(got), 'the var deleted from the environment shows as missing');
  }
  const help = sent.find((s) => /help — this menu|SecondShift monitor/.test(s));
  t(!help || /\/envcheck/.test(help), 'help menu lists /envcheck');

  // help text itself must advertise the command
  t(/\/envcheck/.test(tmon.HELP_TEXT), 'HELP_TEXT documents /envcheck');

  try { tmon.stop(); } catch (_) {}
  mock.close();
  await sleep(200);
  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})();
