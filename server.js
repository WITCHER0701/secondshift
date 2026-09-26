/**
 * SecondShift server — static hosting + APIs.
 * The showcase/deal site for Rishi Raj Singh's automation studio.
 * Routes:
 *   GET  /api/automations        catalog
 *   POST /api/testdrive          log a test-drive event (start / step / complete)
 *   POST /api/deals              submit a deal brief (validated)
 *   GET  /api/stats              live counters for the landing page
 *   GET  /admin.html             leads dashboard (password gated)
 *   POST /admin/login|logout|api/*  admin endpoints
 */
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// minimal .env loader (no deps): KEY=value lines from automation-lab/.env
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const store = require('./data-store');
const voice = require('./voice-agent');
const responder = require('./lead-responder');
const content = require('./content-engine');
const tmon = require('./telegram-monitor');
const { seed } = require('./scripts/seed');

const app = express();
const RAW_PORT = process.env.PORT;
const PORT = (RAW_PORT && parseInt(RAW_PORT, 10) > 0) ? parseInt(RAW_PORT, 10) : 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lab-admin-2026';
const ADMIN_PASSWORD_IS_DEFAULT = !process.env.ADMIN_PASSWORD;
if (ADMIN_PASSWORD_IS_DEFAULT) {
  console.warn('⚠️  ADMIN_PASSWORD not set — using the public default. Anyone can open your admin dashboard. Set ADMIN_PASSWORD in .env / Render env.');
}
// constant-time compare: password checks shouldn't leak length/timing hints
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still burn comparable time before failing
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// behind Render's proxy, req.ip/protocol come from X-Forwarded-* headers
app.set('trust proxy', 1);
app.use(express.json());
// 5xx tap — FIRST middleware: alerts Telegram on any server-error response
// (deduped per route inside the monitor; no-op when Telegram isn't configured)
app.use((req, res, next) => { res.on('finish', () => { if (res.statusCode >= 500) tmon.notify5xx(req, res); }); next(); });
app.use(session({
  secret: process.env.SESSION_SECRET || 'automationlab-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 3600 * 1000,
    httpOnly: true,               // no document.cookie access from JS
    sameSite: 'lax',              // CSRF baseline; cross-site POSTs drop the cookie
    secure: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
  },
}));

// ── rate limits: the site is public; abusive clients must not be able to ─
// brute-force the admin password or balloon the JSON store with junk writes.
const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again in 10 minutes.' },
});
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down a little.' },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});
app.use('/api/', apiLimiter);
// (login limiter lives on the route itself — mounting it here too would double-count every attempt)

// basic hardening headers (kept minimal so inline scripts/styles keep working)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  next();
});
// HTML must always revalidate (etag → 304 when unchanged, fresh when edited);
// hashed/static assets can cache. Prevents visitors getting stale pages.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── public API ────────────────────────────────────────────────────────
app.get('/api/automations', (req, res) => {
  res.json({ automations: store.listAutomations() });
});

app.get('/api/automations/:slug', (req, res) => {
  const a = store.getAutomation(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ automation: a });
});

app.get('/api/stats', (req, res) => {
  res.json(store.stats());
});

const VALID_EVENT = /^(testdrive_started|testdrive_step|testdrive_completed|demo_view)$/;
app.post('/api/testdrive', (req, res) => {
  const { type, slug, step } = req.body || {};
  if (!VALID_EVENT.test(type || '')) return res.status(400).json({ error: 'Invalid event type' });
  const a = store.getAutomation(slug || '');
  if (!a) return res.status(400).json({ error: 'Unknown automation' });
  store.addEvent(type, { slug: a.slug, step: step || null });
  res.json({ ok: true });
});

app.post('/api/deals', writeLimiter, (req, res) => {
  const { name, email, company, industry, automationSlugs, message, monthlyBudget, timeline } = req.body || {};
  const errors = [];
  if (!name || String(name).trim().length < 2) errors.push('Please tell us your name.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) errors.push('A valid email is required.');
  if (!company || String(company).trim().length < 2) errors.push('Company name is required.');
  if (!Array.isArray(automationSlugs) || automationSlugs.length === 0) errors.push('Pick at least one automation.');
  if (String(message || '').length > 4000) errors.push('Message too long.');
  if (errors.length) return res.status(400).json({ errors });

  const lead = store.createLead({ name, email, company, industry, automationSlugs, message, monthlyBudget, timeline });
  store.addEvent('deal_requested', { leadId: lead.id, slugs: lead.automationSlugs });
  res.json({ ok: true, id: lead.id, message: 'Brief received. You\u2019ll hear back within one business day.' });
});

// ── voice agent (The Voice) ───────────────────────────────────
app.post('/api/voice/start', writeLimiter, (req, res) => {
  const session = voice.newSession({ channel: (req.body && req.body.channel) || 'web', userAgent: (req.get('user-agent') || '').slice(0, 120) });
  store.saveCall(session);
  store.addEvent('call_started', { callId: session.id });
  const { reply } = voice.advance(session, ''); // greeting
  // the greeting advance pushes an empty caller turn; trim it
  session.transcript = session.transcript.filter((t) => t.text !== '');
  store.saveCall(session);
  res.json({ ok: true, callId: session.id, reply });
});

app.post('/api/voice/turn', writeLimiter, async (req, res) => {
  const { callId, text } = req.body || {};
  if (!callId || !text) return res.status(400).json({ error: 'callId and text required' });
  const calls = store.listCalls();
  const session = calls.find((c) => c.id === callId);
  if (!session) return res.status(404).json({ error: 'Call not found' });

  const { reply, session: updated, done } = voice.advance(session, String(text).slice(0, 500));

  // appointment created on confirmation
  let appointment = null;
  if (done && updated.slots.service && updated.slots.when && updated.slots.phone) {
    appointment = store.createAppointment({
      callId: updated.id,
      service: updated.slots.service,
      when: updated.slots.when,
      name: updated.slots.name || 'Caller',
      phone: updated.slots.phone,
    });
    store.addEvent('appointment_booked', { callId: updated.id, service: updated.slots.service, when: updated.slots.when });
  }
  store.saveCall(updated);
  res.json({ ok: true, reply, done, appointment });
});

app.get('/api/voice/calls', requireAdmin, (req, res) => res.json({ calls: store.listCalls().slice(0, 50) }));

// ── Vapi web-call config (public key + assistant id for voice.html) ──
app.get('/api/vapi/config', (req, res) => {
  if (!process.env.VAPI_PUBLIC_KEY || !process.env.VAPI_ASSISTANT_ID) {
    return res.json({ configured: false });
  }
  res.json({ configured: true, publicKey: process.env.VAPI_PUBLIC_KEY, assistantId: process.env.VAPI_ASSISTANT_ID });
});

// ── Vapi custom-LLM bridge (The Voice over real phone lines) ─────────
// Vapi POSTs OpenAI chat/completions here on every turn of a call and
// speaks the reply. Our deterministic brain still makes every decision.
const vapiBridge = require('./vapi-bridge');
const VAPI_SECRET = process.env.VAPI_SERVER_SECRET || '';
// ground truth for "did Vapi reach the brain" — surfaced via /api/vapi/ping
// so call failures can be split into brain-side vs voice-side without Render Logs.
const vapiBridgeStats = { hits: 0, lastAt: null, lastReply: '' };
app.post('/vapi/chat/completions', (req, res) => {
  vapiBridgeStats.hits++;
  vapiBridgeStats.lastAt = new Date().toISOString();
  console.log('[vapi-bridge] turn received — msgs:', (req.body && req.body.messages || []).length);
  if (VAPI_SECRET) {
    const auth = req.get('authorization') || '';
    const presented = auth.replace(/^Bearer\s+/i, '').trim();
    if (presented !== VAPI_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const reply = vapiBridge.handleChatCompletion(req, {
      saveCall: (s) => store.saveCall(s),
      createAppointment: (p) => store.createAppointment(p),
      addEvent: (type, data) => store.addEvent(type, data),
    });
    vapiBridgeStats.lastReply = String(reply || '').slice(0, 120);
    res.json({
      id: 'chatcmpl-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'secondshift-voice-brain',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    });
  } catch (e) {
    console.error('[vapi-bridge]', e);
    res.status(500).json({ error: 'brain error' });
  }
});
// public: lets voice.html (and you) verify whether Vapi reached the brain
app.get('/api/vapi/ping', (req, res) => {
  res.json({ ok: true, bridgeHits: vapiBridgeStats.hits, lastHitAt: vapiBridgeStats.lastAt, lastReply: vapiBridgeStats.lastReply });
});

// ── Dograh widget config (public) ──────────────────────────────
// Self-hosted Dograh (Docker on the owner's PC) powers the free line. The
// trycloudflare quick-tunnel URLs change whenever the tunnels restart, so the
// current endpoints live in public/dograh-endpoints.json (tracked in git — the
// repo is public; the embed token is public-by-design, it ships in the page
// DOM anyway). scripts/dograh-watchdog.js keeps that file fresh: it restarts
// dead tunnels, writes the new URLs, and pushes so the next Render deploy
// picks them up. Resolution order: tracked file first, then .env (local dev
// override), so a stale deployed file can never win over a live local one.
function readDograhEndpoints() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'dograh-endpoints.json'), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.token && j.uiUrl && j.apiUrl) return { token: j.token, uiUrl: j.uiUrl.replace(/\/$/, ''), apiUrl: j.apiUrl.replace(/\/$/, '') };
  } catch (e) { /* file missing/malformed — fall through to env */ }
  return null;
}
app.get('/api/dograh/config', (req, res) => {
  const file = readDograhEndpoints();
  const token = (file && file.token) || process.env.DOGRAH_EMBED_TOKEN || '';
  const ui = (file && file.uiUrl) || (process.env.DOGRAH_UI_URL || '').replace(/\/$/, '');
  const api = (file && file.apiUrl) || (process.env.DOGRAH_API_URL || '').replace(/\/$/, '');
  if (!token || !ui || !api) return res.json({ configured: false });
  res.json({ configured: true, token, uiUrl: ui, apiUrl: api });
});
app.get('/api/voice/appointments', requireAdmin, (req, res) => res.json({ appointments: store.listAppointments().slice(0, 50) }));
app.get('/api/voice/session/:id', (req, res) => {
  const s = store.listCalls().find((c) => c.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ session: { id: s.id, state: s.state, slots: s.slots, done: s.done, transcript: s.transcript } });
});

// ── First Response (lead responder) ───────────────────────────
// A lead arrives: instant reply is generated and the qualification thread starts.
app.post('/api/leads/respond', writeLimiter, (req, res) => {
  const { raw, source } = req.body || {};
  if (!raw || !String(raw).trim()) return res.status(400).json({ error: 'raw lead text required' });
  const started = Date.now();
  const session = responder.start({ raw: String(raw).slice(0, 2000), source: source || 'web form', replySeconds: Math.max(4, Math.round((Date.now() - started) / 100) / 10 + 4) });
  store.addEvent('lead_responded', { leadId: session.id, source: session.source });
  res.json({ ok: true, id: session.id, reply: session.reply || null, lead: session.lead });
});
app.post('/api/leads/turn', writeLimiter, (req, res) => {
  const { leadId, text } = req.body || {};
  if (!leadId || !text) return res.status(400).json({ error: 'leadId and text required' });
  const r = responder.turn(leadId, String(text).slice(0, 1000));
  if (!r) return res.status(404).json({ error: 'lead thread not found' });
  res.json({ ok: true, reply: r.reply, done: r.done, lead: r.lead });
});
app.get('/api/leads/thread/:id', (req, res) => {
  const r = store.getLeadRecord(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ lead: r });
});
app.get('/api/leads/threads', requireAdmin, (req, res) => res.json({ leads: store.listLeadRecords().slice(0, 50) }));

// ── Content Crew ──────────────────────────────────────────────
app.post('/api/content/generate', writeLimiter, (req, res) => {
  const { business, subject, vibe, city, offer } = req.body || {};
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'subject required — what did you photograph?' });
  const gen = content.generate({ business, subject, vibe, city, offer });
  store.saveContent(gen);
  store.addEvent('content_generated', { slug: 'content-engine', id: gen.id, vibe: gen.vibe });
  res.json({ ok: true, gen });
});
app.get('/api/content/recent', requireAdmin, (req, res) => res.json({ contents: store.listContents().slice(0, 20) }));

// ── admin ─────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/admin/login', loginLimiter, (req, res) => {
  if (!safeEqual(String(req.body.password || ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  // regenerate: a session id handed out pre-auth must never survive login
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.admin = true;
    res.json({ ok: true });
  });
});
app.post('/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/admin/api/leads', requireAdmin, (req, res) => res.json({ leads: store.listLeads() }));
app.get('/admin/api/events', requireAdmin, (req, res) => res.json({ events: store.listEvents(100) }));
app.get('/admin/api/stats', requireAdmin, (req, res) => res.json(store.stats()));
app.post('/admin/api/leads/:id', requireAdmin, (req, res) => {
  const l = store.updateLead(req.params.id, { status: req.body.status, notes: req.body.notes });
  if (!l) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, lead: l });
});

// ── clients & billing ──────────────────────────────────────────
app.get('/admin/api/clients', requireAdmin, (req, res) => res.json({ clients: store.listClients() }));
app.post('/admin/api/clients', requireAdmin, (req, res) => {
  const { name, email, company, slugs, cycle, notes, leadId } = req.body || {};
  if (!name || !company) return res.status(400).json({ error: 'Name and company required' });
  const client = store.createClient({ name, email, company, slugs, cycle, notes, leadId });
  if (!client) return res.status(400).json({ error: 'At least one valid automation slug required' });
  if (leadId) store.updateLead(leadId, { status: 'won' });
  store.addEvent('client_onboarded', { clientId: client.id, company: client.company, cycle: client.cycle });
  const invoice = store.generateInvoice(client); // first invoice due immediately
  res.json({ ok: true, client, invoice });
});
app.post('/admin/api/clients/:id', requireAdmin, (req, res) => {
  const c = store.updateClient(req.params.id, { status: req.body.status, notes: req.body.notes, cycle: req.body.cycle, slugs: req.body.slugs });
  if (!c) return res.status(404).json({ error: 'Not found' });
  store.addEvent('client_updated', { clientId: c.id, status: c.status });
  res.json({ ok: true, client: c });
});
app.post('/admin/api/clients/:id/invoice', requireAdmin, (req, res) => {
  const c = store.listClients().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Client not found' });
  if (c.status !== 'active') return res.status(400).json({ error: 'Client is not active' });
  const invoice = store.generateInvoice(c);
  store.addEvent('invoice_created', { clientId: c.id, total: invoice.total });
  res.json({ ok: true, invoice });
});
app.get('/admin/api/invoices', requireAdmin, (req, res) => res.json({ invoices: store.listInvoices(req.query.clientId) }));
app.post('/admin/api/invoices/:id/pay', requireAdmin, (req, res) => {
  const inv = store.markInvoicePaid(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  store.addEvent('invoice_paid', { invoiceId: inv.id, total: inv.total });
  res.json({ ok: true, invoice: inv });
});

// ── cloud sync admin ─────────────────────────────────────────
app.get('/admin/api/cloud', requireAdmin, (req, res) => res.json(store.cloudStatus()));
app.post('/admin/api/cloud/push', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await store.cloudPushNow()) }); }
  catch (e) { res.status(502).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/admin/api/cloud/pull', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await store.cloudRestore()) }); }
  catch (e) { res.status(502).json({ ok: false, error: String(e.message || e) }); }
});

// ── health check (Render + uptime monitors) ─────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'secondshift', time: new Date().toISOString(), monitor: tmon.enabled ? 'telegram' : 'local-only' });
});

// ── boot ──────────────────────────────────────────────────────────────
if (require.main === module) {
  seed();

  // ── Telegram monitor (free ops watchdog — full no-op without env vars) ──
  const BASE = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
  if (tmon.enabled) {
    // process-level crashes: alert, keep serving
    process.on('uncaughtException', (err) => {
      console.error('[crash] uncaughtException:', err);
      tmon.notifyCrash('uncaughtException', err);
    });
    process.on('unhandledRejection', (err) => {
      console.error('[crash] unhandledRejection:', err);
      tmon.notifyCrash('unhandledRejection', err);
    });
    // watchdog: critical public routes + cloud sync + the data file
    tmon.startWatchdog({
      intervalMs: 5 * 60 * 1000,
      firstDelayMs: 15 * 1000,
      probes: [
        { name: 'homepage', url: BASE + '/' },
        { name: 'healthz', url: BASE + '/healthz' },
        { name: 'automations API', url: BASE + '/api/automations' },
        { name: 'stats API', url: BASE + '/api/stats' },
        { name: 'voice page', url: BASE + '/voice.html' },
        { name: 'data store', run: () => {
            const { count, file } = store.dataFileHealth();
            return count > 0 ? null : { ok: false, detail: file ? 'data file unreadable/empty' : 'data file missing' };
          } },
        { name: 'cloud sync', run: () => {
            const cs = store.cloudStatus();
            return cs.enabled && cs.lastError ? { ok: false, detail: 'last push/pull error: ' + cs.lastError } : null;
          } },
      ],
    });
    // owner commands: /status /health /help via Telegram long-poll
    tmon.startCommands({
      getSnapshot: () => ({
        leadsTotal: store.listLeads().length,
        leadsOpen: store.listLeads().filter((l) => ['new', 'contacted', 'demo_booked'].includes(l.status)).length,
        leadsWon: store.listLeads().filter((l) => l.status === 'won').length,
        clientsActive: store.listClients().filter((c) => c.status === 'active').length,
        mrr: store.stats().mrr,
        invoicesDue: store.listInvoices().filter((i) => i.status === 'due').length,
        invoicesDueTotal: store.listInvoices().filter((i) => i.status === 'due').reduce((s, i) => s + i.total, 0),
        invoicesPaid: store.listInvoices().filter((i) => i.status === 'paid').length,
        invoicesPaidTotal: store.listInvoices().filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0),
        calls: store.listCalls().length,
        appointments: store.listAppointments().length,
        contents: store.listContents().length,
        events: store.listEvents(10000).length,
      }),
      runHealth: async () => {
        const probes = [
          ['homepage', BASE + '/'], ['healthz', BASE + '/healthz'],
          ['automations API', BASE + '/api/automations'], ['stats API', BASE + '/api/stats'],
          ['admin page', BASE + '/admin.html'], ['voice page', BASE + '/voice.html'],
        ];
        const out = [];
        for (const [name, url] of probes) {
          const t0 = Date.now();
          try {
            const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
            const r = await fetch(url, { signal: ac.signal }); clearTimeout(to);
            out.push({ name, ok: r.ok, detail: r.ok ? null : 'HTTP ' + r.status, ms: Date.now() - t0 });
          } catch (e) { out.push({ name, ok: false, detail: String((e && e.message) || e).slice(0, 80), ms: Date.now() - t0 }); }
        }
        const { count, file } = store.dataFileHealth();
        out.push({ name: 'data store', ok: count > 0, detail: count > 0 ? (count + ' records in file') : (file ? 'unreadable/empty' : 'missing') });
        const cs = store.cloudStatus();
        out.push({ name: 'cloud sync', ok: !(cs.enabled && cs.lastError), detail: cs.enabled ? (cs.lastError ? cs.lastError.slice(0, 60) : cs.provider + ' ok') : 'local mode' });
        return out;
      },
    });
    console.log('[monitor] ✔ Telegram monitor live — alerts + /status /health /help on your chat');
  } else {
    console.log('[monitor] Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — running without remote eyes');
  }

  (async () => {
    const r = await store.cloudRestore();
    if (r.restored) console.log('[cloud] ✔ Restored newer data from ' + store.cloudStatus().provider + ' (' + r.remoteUpdatedAt + ') — local copy backed up as lab.json.local-backup');
    else if (r.reason && !/local mode|local is newer/.test(r.reason)) console.log('[cloud] note: ' + r.reason);
  })();
  app.listen(PORT, () => {
    const cs = store.cloudStatus();
    console.log('──────────────────────────────────────────');
    console.log('  SecondShift — by Rishi Raj Singh');
    console.log(`  ▸ http://localhost:${PORT}`);
    if (process.env.RENDER_EXTERNAL_URL) console.log(`  ▸ live: ${process.env.RENDER_EXTERNAL_URL}`);
    console.log(`  ▸ admin: /admin.html (password: ${ADMIN_PASSWORD_IS_DEFAULT ? '⚠️ DEFAULT — set ADMIN_PASSWORD!' : '•••••••• (set, hidden)'})`);
    console.log(`  ▸ data: ${cs.enabled ? 'LOCAL + ' + cs.provider.toUpperCase() + ' cloud sync' : 'LOCAL (set CLOUD_GIST_TOKEN or FIREBASE_DB_URL to sync)'}`);
    console.log('──────────────────────────────────────────');
  });
}

module.exports = { app };
