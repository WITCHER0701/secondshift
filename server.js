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
const agentRunner = require('./agent-runner');
const { seed } = require('./scripts/seed');

// Dograh free-line endpoints — public/dograh-endpoints.json is the single
// source of truth (tracked in git; dograh-watchdog rewrites + pushes it).
// (.env keys DOGRAH_API_URL/DOGRAH_UI_URL are a fallback only — a boot-time
// read can race the watchdog's .env rewrite and go stale.)
const DOGRAH_CFG = path.join(__dirname, 'public', 'dograh-endpoints.json');
// heartbeat the scheduler-run watchdog appends on every pass — the in-server
// sentinel below uses it to notice when Windows Task Scheduler is stuck
const DOGRAH_WATCHDOG_HEARTBEAT = path.join(__dirname, 'watchdog.heartbeat');
const DOGRAH_WATCHDOG_LOG = path.join(__dirname, 'watchdog.log');
function dograhApiUrl() {
  try { return JSON.parse(fs.readFileSync(DOGRAH_CFG, 'utf8')).apiUrl || process.env.DOGRAH_API_URL || null; } catch (_) { return process.env.DOGRAH_API_URL || null; }
}
async function dograhProbe() {
  const url = dograhApiUrl();
  if (!url) return { ok: false, detail: 'no apiUrl in dograh-endpoints.json' };
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url.replace(/\/$/, '') + '/api/v1/health', { signal: ac.signal });
    clearTimeout(to);
    return r.ok ? { ok: true } : { ok: false, detail: 'HTTP ' + r.status };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, detail: msg.includes('abort') ? 'timeout' : msg.slice(0, 60) };
  }
}
/** One-tap repair: re-run the tunnel watchdog (restarts dead tunnels, updates endpoints, pushes).
 *  Fire-and-forget spawn (detached, unref'd) — NEVER await docker inside the
 *  server process; the Windows pipe-hang that wedged the 01:03 scheduler run
 *  must not be reproducible here. Result arrives in watchdog.log + heartbeat. */
function runDograhWatchdog() {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'dograh-watchdog.js')],
    { cwd: __dirname, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return Promise.resolve({ ok: true, detail: 'watchdog spawned (pid ' + child.pid + ') — result lands in watchdog.log within ~2 min' });
}
/** Scheduler-independent safety net: if the Dograh probe is down AND the
 *  scheduler heartbeat is stale (>8 min), run the watchdog ourselves.
 *  Rate-capped to once per 20 min; a healthy probe resets the timer. */
let lastSentinelRun = 0;
async function dograhSentinelIfNeeded() {
  if (process.platform !== 'win32') return null; // PC-only: Render has no docker/tunnels to heal
  const probe = await dograhProbe();
  if (probe.ok) return null;
  if (Date.now() - lastSentinelRun < 20 * 60 * 1000) return null;
  let hbAgeMs = Infinity;
  try { hbAgeMs = Date.now() - fs.statSync(DOGRAH_WATCHDOG_HEARTBEAT).mtimeMs; } catch (_) { /* no heartbeat yet */ }
  if (hbAgeMs < 8 * 60 * 1000) return null; // scheduler handled it recently — don't double-run
  lastSentinelRun = Date.now();
  const r = await runDograhWatchdog();
  tmon.alertWithFix('🛟 In-server sentinel — Dograh down and scheduler heartbeat stale (' + Math.round(hbAgeMs / 60000) + ' min). Running the tunnel watchdog directly: ' + (r.detail || ''), 'fix-dograh-tunnels', 'dograh-sentinel');
  return r;
}

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

// Don't advertise the framework in every response header (visitors see
// "x-powered-by: Express" otherwise) — no reason to fingerprint our stack.
app.disable('x-powered-by');
// behind Render's proxy, req.ip/protocol come from X-Forwarded-* headers
app.set('trust proxy', 1);

// ── free line: same-origin proxy to the live Dograh tunnels ─────────────
// Quick tunnels rotate every few hours, and each rotation used to reach
// visitors only after commit → push → Render redeploy — the free line sat
// "warming up" for 10+ minutes every time. Two fixes live here:
//   1. This server proxies /free/api/* and /free/ui/* to whichever tunnel
//      registration is healthy right now, so the URLs a visitor's browser
//      uses NEVER change — rotation becomes invisible (and unbranded).
//   2. Endpoints resolve live: the local tracked file first (freshest on
//      the PC, where the watchdog writes it), then GitHub raw, which the
//      watchdog pushes within minutes of a rotation — so a Render deploy
//      no longer has to land before visitors can call again.
// Registered BEFORE express.json so request bodies and websocket upgrades
// stream through untouched.
const FREE_LINE_RAW_URL = process.env.DOGRAH_ENDPOINTS_RAW_URL ||
  'https://raw.githubusercontent.com/WITCHER0701/secondshift/main/public/dograh-endpoints.json';
let freeLineMemo = null;            // { at, eps } — 45s cache, invalidated on failure
const FREE_LINE_TTL = 45 * 1000;

const fetchJsonFresh = async (url, timeoutMs = 6000) => {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; } finally { clearTimeout(to); }
};

const tunnelAlive = async (base) => {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(base + '/api/v1/health', { signal: ac.signal, cache: 'no-store' });
    clearTimeout(to);
    return r.ok;
  } catch (_) { return false; }
};

async function resolveEndpoints(force = false) {
  if (!force && freeLineMemo && Date.now() - freeLineMemo.at < FREE_LINE_TTL) return freeLineMemo.eps;
  const norm = (j) => (j && j.token && j.uiUrl && j.apiUrl)
    ? { token: j.token, uiUrl: j.uiUrl.replace(/\/$/, ''), apiUrl: j.apiUrl.replace(/\/$/, '') } : null;
  const local = norm(readDograhEndpoints());
  const remote = norm(await fetchJsonFresh(FREE_LINE_RAW_URL));
  // local first (freshest where the watchdog writes it), remote second;
  // skip the remote probe when it's identical to the local copy
  const cands = [];
  if (local) cands.push(local);
  if (remote && (!local || remote.apiUrl !== local.apiUrl)) cands.push(remote);
  let eps = null;
  for (const c of cands) { if (await tunnelAlive(c.apiUrl)) { eps = c; break; } }
  if (!eps && cands.length) eps = cands[0]; // best effort — the proxy retries live per request
  freeLineMemo = { at: Date.now(), eps };
  return eps;
}

// follow a redirect only when it stays on OUR tunnels (never an open proxy);
// returns { which, path } so the hop goes back through this same handler
function mapRedirectToTunnel(location, eps) {
  try {
    const u = new URL(location);
    for (const which of ['apiUrl', 'uiUrl']) {
      const t = new URL(eps[which]);
      if (u.host === t.host) return { which, path: u.pathname + u.search };
    }
  } catch (_) {}
  return null;
}

function pipeThrough(req, res, targetUrl, eps, depth) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch (_) { resolve(false); return; }
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const up = mod.request(u, { method: req.method, headers: { ...req.headers, host: u.host }, timeout: 20000 }, (upRes) => {
      const loc = upRes.headers.location;
      const mapped = loc && (req.method === 'GET' || req.method === 'HEAD') && depth < 3
        ? mapRedirectToTunnel(loc, eps) : null;
      if (mapped) {
        upRes.resume(); // drain the redirect body
        resolve(pipeThrough(req, res, eps[mapped.which] + (mapped.path || '/'), eps, depth + 1));
        return;
      }
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('end', () => resolve(true));
      upRes.on('error', () => resolve(true)); // headers already sent — nothing to recover
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => resolve(false));
    req.pipe(up);
    req.on('error', () => { try { up.destroy(); } catch (e) {} resolve(false); });
  });
}

app.use('/free', async (req, res) => {
  const isApi = req.path === '/api' || req.path.startsWith('/api/');
  const which = isApi ? 'apiUrl' : 'uiUrl';
  const suffix = req.path.replace(/^\/(api|ui)/, '') || '/';
  for (let attempt = 0; attempt < 2; attempt++) {
    const eps = await resolveEndpoints(attempt > 0);
    if (!eps || !eps[which]) {
      res.status(503).type('text').send('free line is starting — try again in a moment');
      return;
    }
    if (await pipeThrough(req, res, eps[which] + suffix, eps, 0)) return;
    // upstream refused — endpoints may have rotated mid-request: force a fresh
    // resolution and retry once before giving up
  }
  if (!res.headersSent) res.status(502).type('text').send('free line hiccup — try again in a moment');
});

// websockets (the widget's signaling + audio streaming) bypass express entirely;
// tunnel the raw upgrade through to the same upstream the HTTP proxy picked
function attachFreeLineWs(server) {
  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/free/')) { try { socket.destroy(); } catch (e) {} return; }
    const isApi = req.url.startsWith('/free/api');
    const which = isApi ? 'apiUrl' : 'uiUrl';
    const eps = await resolveEndpoints(true);
    if (!eps || !eps[which]) { try { socket.destroy(); } catch (e) {} return; }
    let u;
    try { u = new URL(eps[which]); } catch (_) { try { socket.destroy(); } catch (e) {} return; }
    const tls = u.protocol === 'https:';
    const netMod = tls ? require('tls') : require('net');
    const up = netMod.connect({ host: u.hostname, port: Number(u.port) || (tls ? 443 : 80), servername: u.hostname }, () => {
      let out = `GET ${req.url.replace(/^\/free\/(api|ui)/, '') || '/'} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries({ ...req.headers, host: u.host })) out += `${k}: ${v}\r\n`;
      out += '\r\n';
      up.write(out);
      if (head && head.length) up.write(head); // early client bytes after the upgrade head
    });
    let handshake = Buffer.alloc(0);
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const idx = handshake.indexOf('\r\n\r\n');
      if (idx === -1) return;
      up.removeListener('data', onData);
      socket.write(handshake.slice(0, idx + 4));          // upstream's 101 (or refusal) verbatim
      const rest = handshake.slice(idx + 4);
      if (rest.length) socket.write(rest);
      socket.pipe(up); up.pipe(socket);                   // raw frames both ways from here
    };
    up.on('data', onData);
    const cleanup = () => { try { socket.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
    socket.on('error', cleanup); up.on('error', cleanup);
    socket.on('close', cleanup); up.on('close', cleanup);
  });
}

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
  // brand images fetched cross-origin (LinkedIn tab) for the upload flows
  if (req.path === '/linkedin-banner-logo.png' || req.path === '/company-logo.png') res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  next();
});
// Internal plumbing is not a visitor asset. The tunnel-endpoints file is read
// from disk by /api/dograh/config and committed for the watchdog — the browser
// never fetches it, so don't serve it (it carries tunnel URLs + the embed token).
app.use('/dograh-endpoints.json', (req, res) => res.status(404).end());

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

// Banner file with permissive CORS so the LinkedIn tab can fetch it for upload
app.get('/linkedin-banner-logo.png', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, 'public', 'linkedin-banner-logo.png'));
});

// ── Keep-alive: Render free tier sleeps after ~15 idle min; a cold brain
// takes 50-60s to wake, but Vapi's custom-LLM gives up after ~30s — the pro
// line goes silent on the first turn of a cold call. Self-ping every 9 min
// keeps this service (the brain) warm. Render sets RENDER=true automatically.
if (process.env.RENDER) {
  const SELF = process.env.RENDER_EXTERNAL_URL || 'https://secondshift-gwv6.onrender.com';
  setInterval(() => {
    fetch(SELF + '/healthz').catch(() => {});
  }, 9 * 60 * 1000).unref();
}

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
app.get('/api/dograh/config', async (req, res) => {
  const eps = await resolveEndpoints();
  const token = (eps && eps.token) || process.env.DOGRAH_EMBED_TOKEN || '';
  if (!token || !eps || !eps.uiUrl || !eps.apiUrl) return res.json({ configured: false });
  // The page gets SAME-ORIGIN URLs (/free/*) which this server proxies to the
  // healthy tunnel — so tunnel rotation never reaches the visitor and the raw
  // tunnel hostnames never appear in a browser payload.
  const origin = req.protocol + '://' + req.get('host');
  res.json({ configured: true, token, uiUrl: origin + '/free/ui', apiUrl: origin + '/free/api' });
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
  // Bare-minimum payload: this endpoint is public, so it says "up" and nothing
  // about our tooling ("on"/"off" instead of naming the alerting channel).
  res.json({ ok: true, service: 'secondshift', time: new Date().toISOString(), monitor: tmon.enabled ? 'on' : 'off' });
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
        { name: 'dograh free line', run: async () => { await dograhSentinelIfNeeded(); return dograhProbe(); },
          diagnoseTask: 'The Dograh free voice line is unreachable from the site. Diagnose: read public/dograh-endpoints.json, check scripts/dograh-watchdog.js behavior, and report in max 5 lines whether this looks like a dead quick tunnel (needs the fix-dograh-tunnels repair), stale endpoints, or a Dograh container problem. Read-only: do not modify files or restart anything.' },
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
        out.push({ name: 'dograh free line', ...(await dograhProbe()) });
        return out;
      },
      // ── one-tap safe remediations (never code edits) ──
      runDiagnose: async () => {
        const issues = [];
        const { count, file } = store.dataFileHealth();
        if (!(count > 0)) issues.push({ problem: 'Data store ' + (file ? 'unreadable/empty' : 'missing'), fix: 'reseed-data' });
        const cs = store.cloudStatus();
        if (cs.enabled && cs.lastError) issues.push({ problem: 'Cloud sync failing', detail: String(cs.lastError).slice(0, 90), fix: 'force-cloud-push' });
        if (vapiBridgeStats.lastError) issues.push({ problem: 'Vapi bridge erroring', detail: String(vapiBridgeStats.lastError).slice(0, 90), fix: 'test-brain' });
        const dg = await dograhProbe();
        if (!dg.ok) issues.push({ problem: 'Dograh free line unreachable', detail: dg.detail || 'tunnel down', fix: 'fix-dograh-tunnels' });
        return issues;
      },
    });
    console.log('[monitor] ✔ Telegram monitor live — alerts + /status /health /diagnose /fix /agent <task> on your chat');

    // ── safe one-tap fixes (registered BEFORE startCommands so buttons route) ──
    tmon.registerFix('reseed-data', async () => {
      const before = store.listEvents(10000).length;
      seed();
      const after = store.listEvents(10000).length;
      return { message: '✅ Data store reseeded (automations restored). Events before/after: ' + before + ' → ' + after + '. Records intact.' };
    });
    tmon.registerFix('force-cloud-push', async () => {
      const r = await store.cloudPushNow();
      if (r && (r.pushed || r.ok)) return { message: '✅ Force-pushed data to ' + store.cloudStatus().provider + '.' };
      throw new Error((r && (r.reason || r.error)) || 'push returned no confirmation');
    });
    tmon.registerFix('test-brain', async () => {
      const t0 = Date.now();
      const r = await fetch('https://secondshift-gwv6.onrender.com/vapi/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { type: 'function-call', functionCall: { name: 'getAssistantReply', parameters: { messages: [{ role: 'user', content: 'telegram health ping' }] } } } }),
      });
      const j = await r.json().catch(() => ({}));
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!r.ok || !txt) throw new Error('HTTP ' + r.status + ' — brain did not reply');
      return { message: '✅ Brain replied in ' + (Date.now() - t0) + 'ms: "' + String(txt).slice(0, 120) + '"' };
    });
    tmon.registerFix('test-agent', () => {
      if (!agentRunner.enabled) return { message: '🤖 Agent runner inactive — add OPENROUTER_API_KEY (free from openrouter.ai/keys) to .env on the PC, then tap this again.' };
      const st = agentRunner.status();
      if (st.running) return { message: '⏳ Agent is already running — /agentstatus to check on it.' };
      // fire-and-forget health ping — instant ack here, result arrives as a follow-up message
      agentRunner.runTask('Health ping: reply with exactly AGENT-OK and nothing else. Do not read or modify any files.', {})
        .then((r) => tmon.send(r.ok
          ? '✅ test-agent: voice-agent brain replied in ' + Math.round((r.durationMs || 0) / 1000) + 's — relay is live.'
          : '❌ test-agent: ' + String(r.text || 'no detail').replace(/^❌ Agent failed: /, '').slice(0, 220)))
        .catch(() => {});
      return { message: '🧪 Agent health ping dispatched — result follows in a moment.' };
    });
    tmon.registerFix('agenthealth', () => {
      if (!agentRunner.enabled) return { message: '🤖 Agent runner inactive — add OPENROUTER_API_KEY (free from openrouter.ai/keys) to .env on the PC.' };
      const a = agentRunner.status();
      return { message: '🤖 ' + a.backend + ' · runs=' + a.runs + ' failed=' + a.failed + (a.running ? ' · RUNNING now' : ' · idle') + (a.lastError ? ' · lastError: ' + String(a.lastError).slice(0, 100) : '') };
    });
    tmon.registerFix('fix-dograh-tunnels', () => {
      const r = runDograhWatchdog();
      if (!r.ok) throw new Error('watchdog spawn failed: ' + (r.detail || 'unknown'));
      // fire-and-forget repair — report the outcome as a follow-up message
      // once the watchdog has had time to recreate tunnels + push endpoints
      setTimeout(() => {
        dograhProbe().then((after) => {
          const msg = after.ok
            ? '✅ fix-dograh-tunnels: free line back — ' + (dograhApiUrl() || '').replace(/^https:\/\//, '').slice(0, 48)
            : '⚠ fix-dograh-tunnels: tunnel still unreachable (' + (after.detail || 'no detail') + ') — details in watchdog.log; retries continue automatically';
          tmon.send(msg).catch(() => {});
        });
      }, 100 * 1000);
      return { message: '🛠 Watchdog spawned — ' + (r.detail || 'repair in progress') };
    });
  } else {
    console.log('[monitor] Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — running without remote eyes');
  }

  (async () => {
    const r = await store.cloudRestore();
    if (r.restored) console.log('[cloud] ✔ Restored newer data from ' + store.cloudStatus().provider + ' (' + r.remoteUpdatedAt + ') — local copy backed up as lab.json.local-backup');
    else if (r.reason && !/local mode|local is newer/.test(r.reason)) console.log('[cloud] note: ' + r.reason);
  })();
  const server = app.listen(PORT, () => {
    attachFreeLineWs(server); // websocket passthrough for the free line
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
