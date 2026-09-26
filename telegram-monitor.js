/**
 * SecondShift Telegram monitor — free "eyes on the systems" for a one-person shop.
 *
 * Design (mirrors cloud-store.js):
 *   • Activates ONLY when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 *     Without them every function is a no-op and ZERO network calls are made —
 *     the site behaves exactly as before.
 *   • Every failure inside this module is caught and timed. It can never throw
 *     into the server, never block a request, and never hold the event loop
 *     (all timers are unref'd). Worst case: a Telegram message is not delivered.
 *   • Alerts are deduped per key with a cooldown, and hard-capped per minute,
 *     so one broken route cannot spam the owner (or Telegram rate limits).
 *   • The Telegram API base is overridable (TELEGRAM_API_BASE) for testing
 *     against a mock Bot API.
 *
 * Alerts:   uncaughtException / unhandledRejection, any 5xx response, watchdog drift.
 * Watchdog: periodic probes (HTTP routes + data-store) with recovery notices.
 * Commands: long-poll getUpdates → /status, /health, /help (owner only).
 */
const path = require('path');

// ── activation ─────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const enabled = !!(TOKEN && CHAT_ID);

// ── tuning ─────────────────────────────────────────────────────────────
const DEDUP_DEFAULT_MS = 10 * 60 * 1000;  // same alert key at most every 10 min
const MAX_SENDS_PER_MIN = 20;             // hard cap: never spam, never rate-banned
const MSG_MAX = 3800;                     // Telegram hard limit is 4096
const HTTP_PROBE_TIMEOUT_MS = 8000;

const state = {
  alertsSent: 0, repliesSent: 0, dropped: 0,
  lastAlertAt: null, lastReplyAt: null, lastError: null,
  startedAt: new Date().toISOString(),
  watchdog: { running: false, lastRunAt: null, lastResults: [] },
  commands: { running: false, replies: {}, lastCommandAt: null },
};

let stopped = false;
const timers = [];
function unref(t) { timers.push(t); if (t && typeof t.unref === 'function') t.unref(); return t; }

// ── low-level sender (never throws) ────────────────────────────────────
async function tgCall(method, payload, timeoutMs = 12000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(TG_API + '/bot' + TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error('telegram ' + method + ' → ' + res.status + (j.description ? ' ' + j.description : ''));
    return j;
  } finally { clearTimeout(to); }
}

// ── rate + dedup bookkeeping ───────────────────────────────────────────
let minuteBucket = { minute: currentMinute(), count: 0 };
function currentMinute() { return Math.floor(Date.now() / 60000); }
const dedupMap = new Map();   // key → last sent at (ms)
const recentByKey = new Map(); // key → [timestamps] for "N in last hour" lines
function pruneRecent(key) {
  const arr = (recentByKey.get(key) || []).filter((t) => Date.now() - t < 3600 * 1000);
  recentByKey.set(key, arr);
  return arr;
}

/**
 * send(text, { key, minGapMs, force })
 *  - key + minGapMs → deduped alert (same key silenced for the window)
 *  - force / no key → always delivered (command replies use this)
 * Resolves { sent, error?, skipped? } — NEVER rejects.
 */
async function send(text, opts = {}) {
  if (!enabled || stopped) return { sent: false, skipped: 'disabled' };
  try {
    const now = Date.now();
    if (minuteBucket.minute !== currentMinute()) minuteBucket = { minute: currentMinute(), count: 0 };
    if (++minuteBucket.count > MAX_SENDS_PER_MIN) {
      state.dropped++;
      return { sent: false, skipped: 'rate-cap' };
    }
    if (opts.key && !opts.force) {
      const gap = opts.minGapMs || DEDUP_DEFAULT_MS;
      const last = dedupMap.get(opts.key) || 0;
      if (now - last < gap) return { sent: false, skipped: 'dedup' };
      dedupMap.set(opts.key, now);
    }
    await tgCall('sendMessage', { chat_id: CHAT_ID, text: String(text).slice(0, MSG_MAX) });
    if (opts.key) {
      state.alertsSent++;
      state.lastAlertAt = new Date().toISOString();
    } else {
      state.repliesSent++;
      state.lastReplyAt = new Date().toISOString();
    }
    return { sent: true };
  } catch (e) {
    state.lastError = String((e && e.message) || e);
    return { sent: false, error: state.lastError };
  }
}

// ── alert builders ─────────────────────────────────────────────────────
function routePattern(req) {
  try {
    const base = req.baseUrl || '';
    const r = req.route && req.route.path ? req.route.path : '';
    if (base || r) return base + r;
    return String(req.originalUrl || req.url || '?').split('?')[0].replace(/\/[0-9a-f_-]{8,}/gi, '/:id');
  } catch (_) { return '?'; }
}

/** Called by the server's 5xx tap after any response with status ≥ 500. */
function notify5xx(req, res) {
  if (!enabled || stopped) return;
  const pat = routePattern(req);
  const key = '5xx:' + req.method + ':' + pat;
  const hits = pruneRecent(key); hits.push(Date.now()); recentByKey.set(key, hits);
  const since = new Date().toISOString().slice(11, 19);
  const text =
    '🚨 5xx — ' + req.method + ' ' + pat + '\n' +
    'path: ' + String(req.originalUrl || req.url || '?').split('?')[0].slice(0, 160) + '\n' +
    'status: ' + res.statusCode + ' · at ' + since + '\n' +
    '(' + hits.length + ' × in the last hour for this route)';
  send(text, { key, minGapMs: 5 * 60 * 1000 }).catch(() => {});
}

/** Called on process-level crashes. err may be anything. */
function notifyCrash(kind, err) {
  if (!enabled || stopped) return;
  const msg = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
  const key = 'crash:' + kind + ':' + msg.slice(0, 60);
  send('💥 ' + kind + ' caught — site still up\n' + msg.slice(0, 300) + (stack ? '\n' + stack.slice(0, 500) : ''), { key, minGapMs: 5 * 60 * 1000 }).catch(() => {});
}

// ── watchdog ───────────────────────────────────────────────────────────
/**
 * startWatchdog({ intervalMs, probes, firstDelayMs })
 * probes: [{ name, url }]            → HTTP probe (2xx/3xx = ok)
 *         [{ name, run: async() }]   → returns null | { ok:false, detail } | throws
 * New failure → alert; failure → recovery notice. Same drift is deduped.
 */
function startWatchdog({ intervalMs = 5 * 60 * 1000, probes = [], firstDelayMs = 15 * 1000 } = {}) {
  if (!enabled) return;
  const since = {}; // name → ISO time the current failure started
  async function probeOne(p) {
    const t0 = Date.now();
    if (p.url) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), HTTP_PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(p.url, { signal: ac.signal });
        if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status, ms: Date.now() - t0 };
        return { ok: true, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, detail: ac.signal.aborted ? 'timeout' : String((e && e.message) || e), ms: Date.now() - t0 };
      } finally { clearTimeout(to); }
    }
    try {
      const r = await p.run();
      return r && r.ok === false ? { ok: false, detail: r.detail || 'drift', ms: Date.now() - t0 } : { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, detail: String((e && e.message) || e), ms: Date.now() - t0 };
    }
  }
  async function tick() {
    if (stopped) return;
    const results = [];
    for (const p of probes) {
      const r = await probeOne(p);
      results.push({ name: p.name, ...r });
      const was = since[p.name];
      if (!r.ok && !was) {
        since[p.name] = new Date().toISOString();
        send('👁 Watchdog — ' + p.name + ' DOWN\n❌ ' + (r.detail || 'drift') + '\nsince ' + since[p.name], { key: 'wd:' + p.name }).catch(() => {});
      } else if (r.ok && was) {
        const mins = Math.max(1, Math.round((Date.now() - new Date(was).getTime()) / 60000));
        delete since[p.name];
        send('✅ Recovered: ' + p.name + ' responding again (was down ' + mins + 'm)', { key: 'wd-ok:' + p.name, force: true }).catch(() => {});
      }
    }
    state.watchdog.lastRunAt = new Date().toISOString();
    state.watchdog.lastResults = results;
  }
  state.watchdog.running = true;
  unref(setTimeout(() => { tick().catch(() => {}); }, firstDelayMs));
  unref(setInterval(() => { tick().catch(() => {}); }, intervalMs));
}

// ── one-tap fix actions (inline keyboards) ─────────────────────────────
// Safety model: actions are REMEDIATION (restart/recover/clear), never code
// edits. Code bugs are diagnosed and located by the bot, but fixed by the
// owner + agent working together — a chat button must never rewrite code.
let fixHandlers = {};
/** registerFix(name, fn) — server registers safe remediation actions. */
function registerFix(name, fn) { fixHandlers[name] = fn; }

async function tgCallForm(method, payload, timeoutMs = 20000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(TG_API + '/bot' + TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return await res.json().catch(() => ({}));
  } finally { clearTimeout(to); }
}

async function answerCallback(id, text) {
  const r = await tgCallForm('answerCallbackQuery', { callback_query_id: id, text: String(text).slice(0, 190) }).catch(() => ({}));
  return r && r.ok;
}

async function alertWithFix(text, fix, key, minGapMs) {
  // deduped alert that carries a one-tap Fix button (fix = registered name)
  const now = Date.now();
  if (minuteBucket.minute !== currentMinute()) minuteBucket = { minute: currentMinute(), count: 0 };
  if (++minuteBucket.count > MAX_SENDS_PER_MIN) { state.dropped++; return { sent: false, skipped: 'rate-cap' }; }
  const gap = minGapMs || DEDUP_DEFAULT_MS;
  const last = dedupMap.get(key) || 0;
  if (now - last < gap) return { sent: false, skipped: 'dedup' };
  dedupMap.set(key, now);
  const kb = fix ? { inline_keyboard: [[{ text: '🔧 Fix: ' + fix, callback_data: 'fix:' + fix }]] } : undefined;
  const r = await tgCallForm('sendMessage', { chat_id: CHAT_ID, text: String(text).slice(0, MSG_MAX), reply_markup: kb }).catch((e) => ({ ok: false, description: String(e) }));
  if (r && r.ok) { state.alertsSent++; state.lastAlertAt = new Date().toISOString(); }
  return r && r.ok ? { sent: true } : { sent: false, error: r && r.description };
}

// fix:xxx callback routing + /fix menu + /diagnose are wired in startCommands

// ── command bot (long-poll getUpdates) ─────────────────────────────────
const HELP_TEXT =
  '🤖 SecondShift monitor — commands\n' +
  '/status — live business numbers (leads, clients, MRR, calls…)\n' +
  '/health — site routes + data file, probed now\n' +
  '/diagnose — find problems, get one-tap fixes\n' +
  '/fix — run a fix by name\n' +
  '/help — this menu\n' +
  'Alerts: I message you automatically on crashes, 5xx spikes, and watchdog drift — with a Fix button when a safe remedy exists.';

function pad(n) { return String(n).padStart(2, '0'); }
function clock(d = new Date()) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US');

function formatStatus(s) {
  const invDue = (s.invoicesDue || 0) && ' · ' + money(s.invoicesDueTotal);
  const invPaid = (s.invoicesPaid || 0) && ' · ' + money(s.invoicesPaidTotal);
  return [
    '📊 SecondShift — ' + clock() + ' local',
    'Leads: ' + (s.leadsTotal || 0) + ' total · ' + (s.leadsOpen || 0) + ' open · ' + (s.leadsWon || 0) + ' won',
    'Clients: ' + (s.clientsActive || 0) + ' active · MRR ' + money(s.mrr),
    'Invoices: ' + (s.invoicesDue || 0) + ' due' + (invDue || '') + ' · ' + (s.invoicesPaid || 0) + ' paid' + (invPaid || ''),
    'Voice: ' + (s.calls || 0) + ' ' + ((s.calls || 0) === 1 ? 'call' : 'calls') + ' · ' + (s.appointments || 0) + ' ' + ((s.appointments || 0) === 1 ? 'appointment' : 'appointments'),
    'Content sets: ' + (s.contents || 0) + ' · Events logged: ' + (s.events || 0),
  ].join('\n');
}

function formatHealth(results) {
  const lines = results.map((r) =>
    (r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' — ' + r.detail : '') + (r.ms != null ? ' (' + r.ms + 'ms)' : ''));
  const bad = results.filter((r) => !r.ok).length;
  return ['🩺 Health — ' + clock() + (bad ? ' · ' + bad + ' PROBLEM' + (bad > 1 ? 'S' : '') : ' · all good'), ...lines].join('\n');
}

/**
 * startCommands({ getSnapshot, runHealth, pollPauseMs })
 * getSnapshot(): plain object of business counters (server injects from data-store).
 * runHealth(): async → [{ name, ok, detail?, ms? }]
 */
function startCommands({ getSnapshot = () => ({}), runHealth = async () => [], runDiagnose = async () => [], pollPauseMs = 500 } = {}) {
  if (!enabled) return;
  state.commands.running = true;
  let offset = 0;
  const reply = (text) => send(text, { force: true });
  async function handleFix(name) {
    const fn = fixHandlers[name];
    if (!fn) return reply('❓ No fix registered as "' + name + '" — try /fix');
    await reply('🔧 Running fix: ' + name + '…');
    try {
      const r = await fn();
      return reply(r && r.message ? r.message : '✅ Fix "' + name + '" done.');
    } catch (e) {
      return reply('❌ Fix "' + name + '" failed: ' + String((e && e.message) || e).slice(0, 250));
    }
  }
  async function handle(text) {
    const cmd = String(text || '').trim().split(/[\s@]/)[0].toLowerCase();
    state.commands.lastCommandAt = new Date().toISOString();
    if (cmd === '/status') { state.commands.replies['/status'] = (state.commands.replies['/status'] || 0) + 1; return reply(formatStatus(getSnapshot())); }
    if (cmd === '/health') {
      state.commands.replies['/health'] = (state.commands.replies['/health'] || 0) + 1;
      try { return reply(formatHealth(await runHealth())); }
      catch (e) { return reply('🩺 /health failed: ' + String((e && e.message) || e).slice(0, 200)); }
    }
    if (cmd === '/diagnose') {
      state.commands.replies['/diagnose'] = (state.commands.replies['/diagnose'] || 0) + 1;
      try {
        const found = await runDiagnose();
        if (!found.length) return reply('🧘 Diagnose — ' + clock() + ' · no problems found. All probes healthy, data intact, tunnels alive.');
        const lines = ['🧘 Diagnose — ' + clock() + ' · ' + found.length + ' issue' + (found.length > 1 ? 's' : '') + ':'];
        const kb = { inline_keyboard: [] };
        for (const f of found) {
          lines.push('• ' + f.problem + (f.detail ? '\n  ' + f.detail : ''));
          if (f.fix && fixHandlers[f.fix]) kb.inline_keyboard.push([{ text: '🔧 Fix: ' + f.fix, callback_data: 'fix:' + f.fix }]);
        }
        return tgCallForm('sendMessage', { chat_id: CHAT_ID, text: lines.join('\n').slice(0, MSG_MAX), reply_markup: kb.inline_keyboard.length ? kb : undefined }).then((r) => { if (r && r.ok) { state.repliesSent++; state.lastReplyAt = new Date().toISOString(); } });
      } catch (e) { return reply('🧘 /diagnose failed: ' + String((e && e.message) || e).slice(0, 200)); }
    }
    if (cmd === '/fix') {
      state.commands.replies['/fix'] = (state.commands.replies['/fix'] || 0) + 1;
      const names = Object.keys(fixHandlers);
      if (!names.length) return reply('No fixes registered yet.');
      return tgCallForm('sendMessage', { chat_id: CHAT_ID, text: '🔧 Available fixes — tap to run:', reply_markup: { inline_keyboard: names.map((n) => [{ text: n, callback_data: 'fix:' + n }]) } }).then((r) => { if (r && r.ok) { state.repliesSent++; state.lastReplyAt = new Date().toISOString(); } });
    }
    if (cmd === '/help' || cmd === '/start') { state.commands.replies['/help'] = (state.commands.replies['/help'] || 0) + 1; return reply(HELP_TEXT); }
    if (cmd.startsWith('/')) return reply('Unknown command ' + cmd + ' — try /help');
    return null; // plain messages are ignored
  }
  (async function loop() {
    while (!stopped && enabled) {
      let updates = [];
      try {
        const j = await tgCall('getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] }, 35000);
        updates = (j && j.result) || [];
        state.lastError = null;
      } catch (e) {
        state.lastError = String((e && e.message) || e);
        await new Promise((r) => setTimeout(r, 5000)); // dead token / offline: retry calmly
        continue;
      }
      for (const u of updates) {
        offset = (u.update_id || 0) + 1;
        // owner-only: strangers who find the bot get silence, never business data
        const cb = u.callback_query;
        if (cb) {
          if (String(cb.from && cb.from.id) !== String(CHAT_ID) && String(cb.message && cb.message.chat && cb.message.chat.id) !== String(CHAT_ID)) { answerCallback(cb.id, 'Not authorized').catch(() => {}); continue; }
          const data = String(cb.data || '');
          answerCallback(cb.id, 'Running…').catch(() => {});
          if (data.startsWith('fix:')) { state.commands.lastCommandAt = new Date().toISOString(); handleFix(data.slice(4)).catch(() => {}); }
          continue;
        }
        const fromChat = u.message && u.message.chat && String(u.message.chat.id);
        if (!fromChat || fromChat !== String(CHAT_ID)) continue;
        const msg = u.message && u.message.text ? u.message.text : '';
        try { await handle(msg); } catch (_) { /* never die on a bad update */ }
      }
      if (!updates.length) await new Promise((r) => setTimeout(r, pollPauseMs));
    }
  })().catch(() => {});
}

// ── lifecycle / introspection ──────────────────────────────────────────
function stop() {
  stopped = true;
  state.watchdog.running = false;
  state.commands.running = false;
  for (const t of timers) { try { clearInterval(t); clearTimeout(t); } catch (_) {} }
}

function status() {
  return {
    enabled,
    chatId: CHAT_ID ? String(CHAT_ID).slice(0, 4) + '…' : null,
    ...state,
    uptimeMin: Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000),
  };
}

module.exports = { enabled, send, notify5xx, notifyCrash, startWatchdog, startCommands, registerFix, alertWithFix, stop, status, formatStatus, formatHealth, HELP_TEXT };
