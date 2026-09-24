#!/usr/bin/env node
/**
 * Telegram monitor E2E — runs the real telegram-monitor.js against a local
 * mock of the Telegram Bot API (same style as cloud-e2e.js).
 *
 * Verifies: enable detection, sendMessage delivery, alert dedup, 5xx alert
 * (route+status, deduped), crash alert, watchdog DOWN + recovery on a seeded
 * fault, /status /health /help /unknown commands replying with real store
 * data, no-env mode making ZERO network calls, and a dead Bot API never
 * throwing into the process.
 *
 * Run: node scripts/telegram-e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MOCK_PORT = 4620;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tg-'));
process.env.SECONDSHIFT_DB = path.join(tmp, 'lab.json');
process.env.TELEGRAM_API_BASE = 'http://localhost:' + MOCK_PORT;
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.TELEGRAM_CHAT_ID = '424242';

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock Telegram Bot API ──────────────────────────────────────────────
const sent = [];            // every sendMessage payload
let health = { ok: true };  // toggle mock behavior (deadToken → 401s)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    const method = m && m[1];
    if (!m || health.deadToken) { res.statusCode = health.deadToken ? 401 : 404; res.end(JSON.stringify({ ok: false, error_code: health.deadToken ? 401 : 404, description: 'mock: rejected' })); return; }
    if (method === 'sendMessage') {
      const j = JSON.parse(body);
      sent.push({ chat_id: j.chat_id, text: j.text });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: j.chat_id }, text: j.text, date: Math.floor(Date.now() / 1000) } }));
    } else if (method === 'getUpdates') {
      const j = JSON.parse(body);
      const queue = health.updates || [];
      health.updates = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: queue.map((text, i) => ({ update_id: (j.offset || 0) + 1 + i, message: { message_id: 900 + i, from: { id: 424242, first_name: 'Rishi' }, chat: { id: 424242 }, date: Math.floor(Date.now() / 1000), text } })) }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); }
  });
});

(async () => {
  await new Promise((r) => server.listen(MOCK_PORT, r));

  // ═══ PART A — no-env mode: ZERO network calls ═══
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete require.cache[require.resolve('../telegram-monitor')];
  const tmonOff = require('../telegram-monitor');
  t(tmonOff.enabled === false, 'no env → monitor disabled');
  {
    const before = sent.length;
    const r = await tmonOff.send('should not appear');
    t(r.sent === false && sent.length === before, 'send() in disabled mode makes no call and resolves');
    tmonOff.notify5xx({ method: 'GET', url: '/x' }, { statusCode: 500 });
    tmonOff.notifyCrash('uncaughtException', new Error('x'));
    await sleep(150);
    t(sent.length === before, 'no-env: crash/5xx hooks are silent no-ops', String(sent.length));
    tmonOff.startWatchdog({ intervalMs: 50, firstDelayMs: 10, probes: [{ name: 'n', run: async () => ({ ok: false, detail: 'x' }) }] });
    await sleep(120);
    t(sent.length === before, 'no-env: watchdog never starts');
  }

  // ═══ PART B — enabled mode ═══
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.TELEGRAM_CHAT_ID = '424242';
  delete require.cache[require.resolve('../telegram-monitor')];
  const tmon = require('../telegram-monitor');
  t(tmon.enabled === true, 'env set → monitor enabled');

  // 1. plain send delivers
  const r1 = await tmon.send('hello from SecondShift', { force: true });
  t(r1.sent === true && sent.length === 1 && sent[0].chat_id === '424242', 'sendMessage delivered to mock API');

  // 2. dedup: same key swallowed inside the window, force bypasses
  const key = 'test:dedup';
  await tmon.send('alert once', { key });
  const after2 = sent.length;
  await tmon.send('alert again', { key });
  t(sent.length === after2, 'same-key alert deduped inside window');
  await tmon.send('alert forced', { key, force: true });
  t(sent.length === after2 + 1, 'force bypasses dedup');

  // 3. 5xx alert: route + status, then deduped
  const fakeReq = { method: 'POST', url: '/api/deals', originalUrl: '/api/deals', route: { path: '/api/deals' } };
  tmon.notify5xx(fakeReq, { statusCode: 502 });
  await sleep(150);
  const five = sent.filter((s) => s.text.startsWith('🚨 5xx'));
  t(five.length === 1 && /POST \/api\/deals/.test(five[0].text) && /status: 502/.test(five[0].text), '5xx alert carries method, route, status');
  tmon.notify5xx(fakeReq, { statusCode: 502 });
  await sleep(150);
  t(sent.filter((s) => s.text.startsWith('🚨 5xx')).length === 1, 'repeat 5xx on same route deduped');

  // 4. crash alert
  tmon.notifyCrash('unhandledRejection', new Error('boom: seeded rejection'));
  await sleep(150);
  const crash = sent.filter((s) => s.text.startsWith('💥'));
  t(crash.length === 1 && /boom: seeded rejection/.test(crash[0].text), 'crash alert delivered with message');

  // 5. watchdog: seeded fault → DOWN alert → recovery notice
  let seedFault = true;
  tmon.startWatchdog({
    intervalMs: 250, firstDelayMs: 30,
    probes: [
      { name: 'seeded-fault', run: async () => (seedFault ? { ok: false, detail: 'cultured drift' } : null) },
      { name: 'always-fine', run: async () => null },
    ],
  });
  await sleep(700);
  const down = sent.filter((s) => s.text.startsWith('👁 Watchdog — seeded-fault DOWN'));
  t(down.length === 1 && /cultured drift/.test(down[0].text), 'watchdog fires DOWN alert on seeded fault');
  t(!sent.some((s) => s.text.includes('always-fine DOWN')), 'healthy probe never alerts');
  seedFault = false;
  await sleep(700);
  const rec = sent.filter((s) => s.text.startsWith('✅ Recovered: seeded-fault'));
  t(rec.length === 1 && /was down \d+m/.test(rec[0].text), 'watchdog reports recovery');

  // 6. commands — real store data (wired like server.js injects it)
  const store = require('../data-store');
  store.createLead({ name: 'E2E Tester', email: 'e2e@test.dev', company: 'Mock Co', message: 'hi' });
  store.saveCall({ id: 'e2e-call-1', state: 'done', slots: {}, transcript: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), done: true });
  store.createAppointment({ callId: 'e2e-call-1', service: 'haircut', when: 'tomorrow 2pm', name: 'E2E Tester', phone: '5550101' });
  tmon.startCommands({
    getSnapshot: () => ({
      leadsTotal: store.listLeads().length,
      leadsOpen: store.listLeads().filter((l) => ['new', 'contacted', 'demo_booked'].includes(l.status)).length,
      leadsWon: store.listLeads().filter((l) => l.status === 'won').length,
      clientsActive: store.listClients().filter((c) => c.status === 'active').length,
      mrr: store.stats().mrr,
      invoicesDue: 0, invoicesDueTotal: 0, invoicesPaid: 0, invoicesPaidTotal: 0,
      calls: store.listCalls().length,
      appointments: store.listAppointments().length,
      contents: store.listContents().length,
      events: store.listEvents(10000).length,
    }),
    runHealth: async () => {
      const out = [{ name: 'mock-route', ok: true, ms: 5 }];
      const { count, file, error } = store.dataFileHealth();
      out.push({ name: 'data store', ok: count > 0, detail: count > 0 ? count + ' records in file' : (error || (file ? 'unreadable/empty' : 'missing')) });
      return out;
    },
  });
  health.updates = ['/status', '/help', '/nonsense', 'just chatting'];
  await sleep(900);
  const texts = sent.map((s) => s.text);
  const statusMsg = texts.find((x) => x.startsWith('📊 SecondShift'));
  t(!!statusMsg && /Leads: 1 total · 1 open · 0 won/.test(statusMsg) && /Voice: 1 call · 1 appointment/.test(statusMsg), '/status replies with real store numbers', statusMsg ? '' : 'NOT FOUND; texts=' + JSON.stringify(texts));
  const helpMsg = texts.find((x) => x.startsWith('🤖 SecondShift monitor'));
  t(!!helpMsg && /\/status/.test(helpMsg), '/help replies with the menu');
  t(texts.some((x) => x.startsWith('Unknown command /nonsense')), 'unknown command gets guidance');
  t(!texts.some((x) => x.includes('just chatting')), 'plain chat ignored');

  // 7. /health — per-route probe results (seed a data-store fault)
  const origHealth = store.dataFileHealth;
  store.dataFileHealth = () => ({ ok: false, count: 0, file: null, error: 'cultured: file gone' });
  health.updates = ['/health'];
  await sleep(900);
  const healthMsg = sent.map((s) => s.text).filter((x) => x.startsWith('🩺 Health')).pop() || '';
  t(/❌ data store/.test(healthMsg) && /file gone/.test(healthMsg), '/health reports the seeded data-store fault');
  store.dataFileHealth = origHealth;
  tmon.stop();

  // ═══ PART C — dead token: API 401s, nothing throws, site unaffected ═══
  health.deadToken = true;
  delete require.cache[require.resolve('../telegram-monitor')];
  process.env.TELEGRAM_BOT_TOKEN = 'DEAD:TOKEN';
  const tmonDead = require('../telegram-monitor');
  const rd = await tmonDead.send('will fail');
  t(rd.sent === false && !!rd.error && /401/.test(rd.error), 'dead token → send resolves with error, no throw');
  let threw = false;
  process.on('uncaughtException', () => { threw = true; });
  tmonDead.startCommands({ getSnapshot: () => ({}) });
  tmonDead.startWatchdog({ intervalMs: 100, firstDelayMs: 20, probes: [{ name: 'x', run: async () => ({ ok: false }) }] });
  await sleep(600);
  t(!threw, 'dead token: polling + watchdog run without crashing the process');
  tmonDead.stop();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? '\nTELEGRAM_E2E_PASS' : '\nTELEGRAM_E2E_FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
