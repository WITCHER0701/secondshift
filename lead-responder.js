/**
 * SecondShift — First Response: the lead responder brain.
 *
 * The moment a lead arrives (web form, DM, email export), this engine:
 *   1. sends a warm, specific reply in seconds (zero keys required)
 *   2. qualifies on budget / timeline / intent
 *   3. scores the lead and writes a brief for the owner
 *   4. persists everything (queue + transcript) to the store
 *
 * Free by design: rule-based NLP (same philosophy as voice-agent.js).
 * Optional upgrade: point REPLY_LLM_URL at an OpenAI-compatible endpoint
 * (Ollama works) for richer phrasing — the flow stays the same.
 */
const store = require('./data-store');

const BUSINESS = {
  name: process.env.FR_BUSINESS_NAME || 'Summit Roofing',
  type: process.env.FR_BUSINESS_TYPE || 'home services',
  ownerName: process.env.FR_OWNER_NAME || 'the owner',
  calendar: process.env.FR_CALENDAR_URL || 'https://cal.example.com/summit-roofing',
};

const SPEED_TARGET_SECONDS = 30; // the promise: reply lands within this

// ── extraction helpers (how people actually write leads) ──────────────
function extractBudget(text) {
  const t = String(text || '').toLowerCase();
  const m = t.match(/\$?\s*(\d[\d,]*)\s*(k)?/);
  if (m) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n *= 1000;
    if (n >= 100) return Math.round(n);
  }
  if (/\b(cheap|budget|affordable|financing|payment plan)\b/.test(t)) return 'unsure';
  return null;
}

function extractTimeline(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(asap|urgent|emergency|today|tonight|right now|immediately|leaking|flood)\b/.test(t)) return 'immediately';
  if (/\b(this week|few days|couple of days|by friday|by monday)\b/.test(t)) return 'this week';
  if (/\b(this month|next week|couple weeks|few weeks)\b/.test(t)) return '2-4 weeks';
  if (/\b(just looking|browsing|someday|next year|no rush|exploring|researching|thinking about)\b/.test(t)) return 'browsing';
  return null;
}

function extractName(text) {
  const m = String(text || '').match(/\b(?:i'?m|i am|my name is|this is|name:)\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1);
  const form = String(text || '').match(/\bname:\s*([^\n,;]+)/i);
  if (form) return form[1].trim();
  return null;
}

function extractContact(text) {
  const email = String(text || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const phone = String(text || '').match(/(\+?\d[\d\s().-]{8,}\d)/);
  return { email: email ? email[0] : null, phone: phone ? phone[0].trim() : null };
}

function extractProject(text) {
  const t = String(text || '').toLowerCase();
  const known = {
    'roof replacement': /roof.*(replace|new roof|redone)/,
    'roof repair': /roof.*(repair|leak|fix|damage)/,
    'roof inspection': /roof.*(inspect|check|assessment)/,
    'gutter work': /gutter/,
    'plumbing': /plumb|leak|pipe|faucet|water heater|heater|drain|toilet/,
    'kitchen remodel': /kitchen/,
    'bathroom remodel': /bathroom|bath remodel/,
    'painting': /paint/,
    'flooring': /floor/,
    'hvac service': /\bhvac\b|air condition|heating|furnace/,
    'buying a home': /buying|purchase|house hunt|make an offer/,
    'selling a home': /selling|list my|put it on the market/,
  };
  for (const [name, re] of Object.entries(known)) if (re.test(t)) return name;
  // freeform: first meaningful clause (time/urgency words are NOT projects)
  const cleaned = String(text || '')
    .replace(/^(hi|hello|hey)[,!\s]+/i, '')
    .replace(/\b(i|i'm|im|i am|we|my|our|the|a|an|is|are|need|needs|want|looking|look|for|help|with|to|have|has|got|get|please|and|in|on|at|of|this|next|that|week|weeks|month|today|tomorrow|tonight|asap|urgent|if|possible|maybe|around|about|budget)\b/gi, ' ')
    .replace(/\b\d+[\d,]*\s*(k|dollars|bucks|\$)?/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (cleaned && cleaned.split(' ').length <= 8 && !/^\d+$/.test(cleaned)) return cleaned;
  return null;
}

// ── scoring ───────────────────────────────────────────────────────────
function scoreLead(slots) {
  let score = 0;
  const notes = [];
  if (slots.timeline === 'immediately') { score += 40; notes.push('urgent timeline'); }
  else if (slots.timeline === 'this week') { score += 30; notes.push('timeline: this week'); }
  else if (slots.timeline === '2-4 weeks') { score += 18; notes.push('timeline: 2-4 weeks'); }
  else if (slots.timeline === 'browsing') { score += 4; notes.push('early-stage browser'); }
  if (typeof slots.budget === 'number') {
    score += slots.budget >= 5000 ? 35 : slots.budget >= 1000 ? 25 : 15;
    notes.push('budget stated: $' + slots.budget.toLocaleString());
  } else if (slots.budget === 'unsure') { score += 5; notes.push('budget-sensitive'); }
  else notes.push('budget unknown');
  if (slots.email || slots.phone) { score += 15; notes.push('contact left: ' + (slots.email || slots.phone)); }
  if (slots.project) { score += 10; notes.push('clear project: ' + slots.project); }
  if (slots.name) score += 5;
  return { score: Math.min(score, 100), notes, temp: score >= 60 ? '🔥 hot' : score >= 30 ? 'lukewarm' : '❄️ nurture' };
}

function ownerBrief(lead) {
  const s = lead.slots, sc = lead.score;
  const lines = [
    `NEW LEAD · ${sc.temp} (${sc.score}/100)`,
    `Project: ${s.project || '—'}`,
    `Timeline: ${s.timeline || '—'} · Budget: ${typeof s.budget === 'number' ? '$' + s.budget.toLocaleString() : (s.budget || '—')}`,
    `Contact: ${s.name || '—'} · ${s.email || s.phone || '—'}`,
    `Arrived: ${new Date(lead.createdAt).toLocaleString()} → replied in ${lead.replySeconds}s`,
    sc.notes.length ? `Why: ${sc.notes.join(' · ')}` : '',
    sc.score >= 60 ? '👉 Call this one TODAY — they are ready.' : sc.score >= 30 ? '👉 Follow up within 24h.' : '👉 Drop into the monthly nurture sequence.',
  ];
  return lines.filter(Boolean).join('\n');
}

// ── conversation engine ───────────────────────────────────────────────
/**
 * A session is one lead's qualification thread.
 * start() → { id, reply, lead }      (the instant reply)
 * turn(id, text) → { reply, done, lead }
 * States: greeted -> ask_timeline -> ask_budget -> qualified -> booked
 */
function start(meta) {
  const now = store.now();
  const session = {
    id: store.uid('lead'),
    state: 'greeted',
    slots: { project: null, timeline: null, budget: null, name: null, email: null, phone: null },
    transcript: [],
    source: (meta && meta.source) || 'web form',
    raw: (meta && meta.raw) || '',
    replySeconds: (meta && meta.replySeconds) || SPEED_TARGET_SECONDS,
    createdAt: now,
    updatedAt: now,
  };
  // extract everything the first message already contains
  const first = meta && meta.raw ? meta.raw : '';
  if (first) applyExtraction(session, first);
  const lead = save(session);
  const reply = instantReply(session);
  push(session, 'agent', reply);
  save(session);
  return { id: session.id, reply, lead };
}

function applyExtraction(session, text) {
  const s = session.slots;
  const proj = extractProject(text); if (proj && !s.project) s.project = proj;
  const tl = extractTimeline(text); if (tl && !s.timeline) s.timeline = tl;
  const bud = extractBudget(text); if (bud && !s.budget) s.budget = bud;
  const nm = extractName(text); if (nm && !s.name) s.name = nm;
  const c = extractContact(text);
  if (c.email && !s.email) s.email = c.email;
  if (c.phone && !s.phone) s.phone = c.phone;
}

function instantReply(session) {
  const s = session.slots;
  const hi = s.name ? `Hi ${s.name}` : 'Hi there';
  const proj = s.project ? ` about your ${s.project}` : '';
  const urgent = s.timeline === 'immediately';
  if (urgent) {
    return `${hi} — this is First Response at ${BUSINESS.name}. I saw your message${proj} come in and I'm on it right now. 🚨\n\nIf this is an emergency (active leak, no power, safety issue) call our 24/7 line and a human is dispatched today. Otherwise — two quick questions and I'll have ${BUSINESS.ownerName} call you with a plan:\n\n1. When do you need this done?`;
  }
  return `${hi} — thanks for reaching out to ${BUSINESS.name}! I'm First Response, the assistant that never sleeps. You wrote in${proj} and I can already tell you're in the right place.\n\n${BUSINESS.ownerName[0].toUpperCase() + BUSINESS.ownerName.slice(1)} personally handles every project, so let me get you a fast, accurate quote. Two quick questions:\n\n1. When are you hoping to have this done?`;
}

function nextQuestion(session) {
  const s = session.slots;
  if (!s.timeline) return 'When are you hoping to have this done — ASAP, this week, this month, or just exploring?';
  if (!s.budget) return 'Got it. And do you have a budget range in mind? Even a rough one helps me prep the right options.';
  return null; // qualified
}

function turn(id, text) {
  const session = data_get(id);
  if (!session) return null;
  push(session, 'lead', String(text || ''));
  applyExtraction(session, text);
  const s = session.slots;
  let reply, done = false;

  const q = nextQuestion(session);
  if (q) {
    reply = q;
    session.state = s.timeline && s.budget ? 'qualified' : (s.timeline ? 'ask_budget' : 'ask_timeline');
    if (session.state === 'qualified') session.state = 'qualified';
  } else {
    // qualified → score + book + brief
    const sc = scoreLead(s);
    session.score = sc;
    session.state = 'booked';
    done = true;
    reply =
      `Perfect — that's everything I need. ✅\n\nHere's what happens now:\n` +
      `1. ${BUSINESS.ownerName[0].toUpperCase() + BUSINESS.ownerName.slice(1)} gets your brief immediately (${sc.temp}, ${sc.score}/100)\n` +
      `2. You'll get a call within ${s.timeline === 'immediately' ? 'the hour' : '24 hours'}\n` +
      `3. Want to skip the phone tag? Grab a slot directly: ${BUSINESS.calendar}\n\nThanks for choosing ${BUSINESS.name} — talk soon!`;
    store.addEvent('lead_qualified', { slug: 'lead-responder', score: sc.score });
  }
  push(session, 'agent', reply);
  const lead = save(session);
  return { reply, done, lead };
}

// ── persistence ───────────────────────────────────────────────────────
function push(session, role, text) {
  session.transcript.push({ role, text, at: store.now() });
  session.updatedAt = store.now();
}
function save(session) {
  const lead = {
    id: session.id,
    state: session.state,
    slots: session.slots,
    score: session.score || scoreLead(session.slots),
    source: session.source,
    replySeconds: session.replySeconds,
    transcript: session.transcript,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  store.upsertLeadRecord(lead);
  return lead;
}
// internal: fetch a live session from the store
function data_get(id) {
  const rec = store.getLeadRecord(id);
  return rec || null;
}

module.exports = { start, turn, scoreLead, ownerBrief, extractBudget, extractTimeline, extractName, extractContact, extractProject, SPEED_TARGET_SECONDS };
