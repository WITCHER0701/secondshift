/**
 * SecondShift — The Voice: a free voice-agent brain.
 *
 * Design: a deterministic slot-filling agent (book / ask / route) that runs
 * with ZERO API keys. For richer phrasing you can point it at a free/local
 * LLM (Ollama on your own machine, or any OpenAI-compatible endpoint) —
 * the rule engine stays as the backbone and the fallback.
 *
 * The "voice" part (STT in, TTS out) happens in the browser via the free
 * Web Speech API — see public/voice.html. Real phone lines: see VOICE-AGENT.md.
 */
const store = require('./data-store');

// ── business config (the tenant) ──────────────────────────────────────
const BUSINESS = {
  name: process.env.VOICE_BUSINESS_NAME || 'Demo Business',
  type: process.env.VOICE_BUSINESS_TYPE || 'auto repair shop',
  hours: 'Monday to Saturday, 8am to 6pm',
};

// Service menus per industry + the keywords callers actually say.
// Anything we can't canonicalize is accepted freeform — never dead-loop.
const SERVICE_MENUS = {
  'auto repair shop': ['oil change', 'brake service', 'tire rotation', 'inspection', 'battery replacement', 'alignment', 'AC service'],
  'salon':            ['haircut', 'hair color', 'blowout', 'beard trim', 'manicure', 'pedicure', 'facial', 'massage'],
  'restaurant':       ['table reservation', 'dinner reservation', 'lunch reservation', 'private event', 'tasting menu'],
  'clinic':           ['checkup', 'consultation', 'cleaning', 'follow-up visit'],
  'generic':          ['appointment', 'consultation', 'estimate', 'general visit'],
};
function menuFor(type) { return SERVICE_MENUS[type] || SERVICE_MENUS.generic; }

// keyword -> canonical service, per industry (first match wins)
const SERVICE_KEYWORDS = {
  'auto repair shop': { oil: 'oil change', brake: 'brake service', tire: 'tire rotation', rotat: 'tire rotation', inspect: 'inspection', battery: 'battery replacement', align: 'alignment', 'ac ': 'AC service', 'a/c': 'AC service', air: 'AC service' },
  salon: { haircut: 'haircut', cut: 'haircut', trim: 'haircut', color: 'hair color', colour: 'hair color', dye: 'hair color', blow: 'blowout', beard: 'beard trim', manicure: 'manicure', nail: 'manicure', pedicure: 'pedicure', facial: 'facial', massage: 'massage' },
  restaurant: { reservation: 'table reservation', table: 'table reservation', book: 'table reservation', dinner: 'dinner reservation', lunch: 'lunch reservation', party: 'private event', event: 'private event', tasting: 'tasting menu' },
  clinic: { checkup: 'checkup', consult: 'consultation', clean: 'cleaning', 'follow': 'follow-up visit' },
  generic: { appoint: 'appointment', consult: 'consultation', estimate: 'estimate', quote: 'estimate' },
};
function keywordsFor(type) { return SERVICE_KEYWORDS[type] || SERVICE_KEYWORDS.generic; }

// ── time parsing (covers how people actually talk) ────────────────────
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TIMEY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|afternoon|evening|noon)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i;

function parseWhen(text) {
  const t = text.toLowerCase();
  const nowD = new Date();
  let d = new Date(nowD);
  let dayConfident = false;

  if (/\btoday\b/.test(t)) { dayConfident = true; }
  else if (/\btomorrow\b/.test(t)) { d.setDate(d.getDate() + 1); dayConfident = true; }
  else {
    for (let i = 0; i < DAYS.length; i++) {
      if (new RegExp('\\b' + DAYS[i] + '\\b').test(t)) {
        const delta = (i - d.getDay() + 7) % 7 || 7; // next occurrence, not today
        d.setDate(d.getDate() + delta);
        dayConfident = true;
        break;
      }
    }
  }
  if (!dayConfident) d.setDate(d.getDate() + 1); // default: tomorrow

  // time: "3pm", "at 10:30", "nine in the morning", "half past 2"
  let hour = null, minute = 0;
  const hm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    minute = hm[2] ? parseInt(hm[2], 10) : 0;
    if (hm[3] === 'pm' && hour < 12) hour += 12;
    if (hm[3] === 'am' && hour === 12) hour = 0;
    if (!hm[3] && hour < 8) hour += 12; // "at 3" during business => 3pm
  } else {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, noon: 12 };
    const wm = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)\b/);
    if (wm) {
      hour = words[wm[1]];
      if (/afternoon|pm|evening/.test(t) && hour < 12) hour += 12;
      if (hour < 8 && !/morning|am/.test(t)) hour += 12;
    }
  }
  if (hour !== null) d.setHours(hour, minute, 0, 0);
  else d.setHours(10, 0, 0, 0); // default 10am
  return d;
}

function parseService(text) {
  const t = ' ' + text.toLowerCase() + ' ';
  const boundary = (needle) => new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  // 1) canonical keyword match for this industry (word-boundary: "air" must not fire inside "haircut")
  const kw = keywordsFor(BUSINESS.type);
  for (const [needle, canonical] of Object.entries(kw)) {
    if (boundary(needle).test(t)) return canonical;
  }
  // 2) exact menu-name match (any industry)
  const menu = menuFor(BUSINESS.type);
  const exact = menu.find((s) => t.includes(s));
  if (exact) return exact;
  // 3) freeform: strip time expressions + booking filler words and accept what's left
  const stripped = text
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|afternoon|evening|noon)\b/gi, ' ')
    .replace(/\b(at|on)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, ' ')
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, ' ')
    .replace(/\b\d{1,2}(:\d{2})\b/g, ' ')
    .replace(/^(hi|hello|hey|yes|please)[,\s]+/i, '')
    .replace(/\b(i want to|i need to|i'd like|i would like|want to|need to|i want|i need|i'd|i would|let me|let's|can you|could you|can|may|we|will|would|like|get|make|schedule|book|booking|reserve|reserving|have|do|a|an|the|for|me|my|us|please|thanks|thank you|i)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (stripped && stripped.split(' ').length <= 6 && /[a-z]/i.test(stripped)) {
    return stripped;
  }
  return null;
}

function parseName(text) {
  const m = text.match(/\b(?:name is|this is|it's|my name['’]s?|i'?m)\s+([A-Za-z][a-z'’-]{1,}(?:\s+[A-Za-z][a-z'’-]{1,}){0,2})/i);
  if (m) {
    let name = m[1];
    // cut at the first common stopword so trailing sentence words never leak in
    // ("Priya and my number is…" → "Priya", "here to book" → "Here")
    name = name.replace(/\s+\b(and|or|but|so|my|the|a|an|to|is|was|at|from|with|number|phone|mobile|email|calling)\b.*$/i, '').trim();
    return name.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  // fallback: a capitalized word or two not in the dictionary of common words
  const cap = text.match(/\b([A-Z][a-z]{1,})(?:\s+([A-Z][a-z]{1,}))?\b/);
  if (cap && !/^(Hi|Hello|Hey|Yes|Yeah|Sure|Okay|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Thanks|Thank|What|When|Where|Book|Schedule|Please|Perfect|Great|Awesome|Cool|Fine|Alright|Sorry|And|But|The|My|It|Today|Tomorrow)$/i.test(cap[1])) return cap[2] ? cap[1] + ' ' + cap[2] : cap[1];
  return null;
}

function parsePhone(text) {
  const digits = (text.match(/\d/g) || []).join('');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// ── the conversation engine ───────────────────────────────────────────
/**
 * advance(session, userText) -> { reply, session, done, intent, appointment }
 * States: greeting -> collect_service -> collect_time -> collect_name -> collect_phone -> confirm -> done
 */
function newSession(meta) {
  return {
    id: store.uid('call'),
    state: 'greeting',
    slots: { service: null, when: null, name: null, phone: null },
    tentative: null,
    transcript: [],
    intent: null,
    meta: meta || {},
    startedAt: store.now(),
    updatedAt: store.now(),
  };
}

function fmtWhen(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// after a time is known: jump to the first slot still missing (reschedule-aware)
function advanceToName(s, when) {
  s.slots.when = when.toISOString();
  if (s.slots.name && s.slots.phone) { s.state = 'confirm'; return `Got it — ${s.slots.service} on ${fmtWhen(when)}, for ${s.slots.name}. Should I lock it in?`; }
  if (s.slots.name) { s.state = 'collect_phone'; return 'Got it. And the best phone number to reach you?'; }
  s.state = 'collect_name';
  return `${fmtWhen(when)} — got it. Can I get your name?`;
}

function advance(session, userText) {
  const s = session;
  const text = String(userText || '').trim();
  s.transcript.push({ role: 'caller', text, at: store.now() });
  s.updatedAt = store.now();

  // global intents: price/hours questions can interrupt anywhere
  const t = text.toLowerCase();
  let reply = '';

  const answerSideQuestion = () => {
    if (/\b(hour|open|close|when are you)\b/.test(t)) {
      return `We're open ${BUSINESS.hours}.`;
    }
    if (/\b(how much|price|cost|charge)\b/.test(t)) {
      return `Pricing depends on your ${BUSINESS.type === 'auto repair shop' ? 'vehicle' : 'service'} — the shop will confirm exact pricing when they see the job, but booking the slot is free.`;
    }
    if (/\b(where|address|located|location)\b/.test(t)) {
      return `You can find the address on our Google profile — just search ${BUSINESS.name}.`;
    }
    return null;
  };

  switch (s.state) {
    case 'greeting': {
      s.intent = /book|appointment|schedule|service|repair|visit|check|reservation|table|haircut|nail|facial|massage|oil|brake|tire|inspection|order/i.test(text) ? 'book' : 'question';
      const side = answerSideQuestion();
      const svcNow = parseService(text);
      const timey = TIMEY_RE.test(text);
      if (svcNow && timey) { s.slots.service = svcNow; reply = (side ? side + ' ' : '') + advanceToName(s, parseWhen(text)); break; }
      if (side) {
        if (svcNow) { s.slots.service = svcNow; s.state = 'collect_time'; reply = `${side} I can get that ${svcNow} booked — what day and time work?`; }
        else { s.state = 'collect_service'; reply = side + ' Would you like to book an appointment while you have me on the line?'; }
        break;
      }
      if (s.intent === 'book' || svcNow) {
        if (svcNow) { s.slots.service = svcNow; s.state = 'collect_time'; reply = `You got it — ${svcNow}. What day and time work for you?`; }
        else { s.state = 'collect_service'; reply = `Absolutely, I can get that booked. What do you need done — ${menuFor(BUSINESS.type).slice(0, 3).join(', ')}, or something else?`; }
      } else {
        s.state = 'collect_service';
        reply = `Hi, thanks for calling ${BUSINESS.name}! I can help with bookings or questions. What can I do for you?`;
      }
      break;
    }
    case 'collect_service': {
      const side = answerSideQuestion();
      const svc = parseService(text);
      const timey = TIMEY_RE.test(text);
      if (svc && s.tentative && !timey) {
        s.slots.service = svc; reply = advanceToName(s, new Date(s.tentative)); s.tentative = null;
      } else if (svc && timey) {
        s.slots.service = svc; s.tentative = null; reply = advanceToName(s, parseWhen(text));
      } else if (svc) {
        s.slots.service = svc; s.tentative = null; s.state = 'collect_time';
        reply = `${svc} it is. What day and time work best?`;
      } else if (timey) {
        s.tentative = parseWhen(text).toISOString();
        reply = (side ? side + ' ' : '') + 'Got it — and what service do you need?';
      } else if (side) { reply = side + ' And what service do you need?'; }
      else if (/\b(not sure|don't know|dont know|help|advice)\b/i.test(text)) {
        s.slots.service = 'general visit'; s.state = 'collect_time';
        reply = 'No problem — I\u2019ll book a general visit and the team can take it from there. What day works?';
      } else { reply = `Could you tell me what you need done? For example: ${menuFor(BUSINESS.type).slice(0, 4).join(', ')}.`; }
      break;
    }
    case 'collect_time': {
      const side = answerSideQuestion();
      if (!TIMEY_RE.test(text) && side) {
        reply = side + ' And when should I book it?'; break;
      }
      reply = advanceToName(s, parseWhen(text));
      break;
    }
    case 'collect_name': {
      const name = parseName(text);
      if (name) {
        s.slots.name = name;
        const phoneNow = parsePhone(text); // “Priya, 555 234 8890” — slots in one breath
        if (phoneNow) s.slots.phone = phoneNow;
        if (s.slots.phone) { s.state = 'confirm'; reply = `Perfect. ${s.slots.service} on ${fmtWhen(new Date(s.slots.when))} for ${name} — should I lock it in?`; }
        else { s.state = 'collect_phone'; reply = `Thanks, ${name}. What's the best phone number to reach you?`; }
      }
      else { reply = 'Sorry, I didn\u2019t catch the name — could you say it again?'; }
      break;
    }
    case 'collect_phone': {
      const phone = parsePhone(text);
      if (phone) {
        s.slots.phone = phone;
        s.state = 'confirm';
        reply = `Perfect. So that's ${s.slots.service} on ${fmtWhen(new Date(s.slots.when))}, for ${s.slots.name}, number ending ${phone.slice(-4)}. Should I book it?`;
      } else { reply = 'I need a 10-digit phone number — what\u2019s the best one to reach you?'; }
      break;
    }
    case 'confirm': {
      if (/\b(yes|yeah|yep|sure|correct|right|book it|do it|please|confirm)\b/i.test(t)) {
        s.state = 'done'; s.done = true;
        reply = `You're all booked! ${s.slots.service} on ${fmtWhen(new Date(s.slots.when))}. We'll text a reminder to ${s.slots.phone}. Anything else?`;
      } else if (/\b(no|change|different|wrong|actually)\b/i.test(t)) {
        s.state = 'collect_time'; s.slots.when = null;
        reply = 'No problem — what day and time would you prefer instead?';
      } else {
        const side = answerSideQuestion();
        reply = side ? side + ' — should I go ahead and book it?' : 'Just yes or no — should I lock in that appointment?';
      }
      break;
    }
    case 'done': {
      reply = /book|another|also/i.test(text) ? 'Of course — let\u2019s start a new booking. What do you need done?' :
        `Thanks for calling ${BUSINESS.name}. See you soon, ${s.slots.name || 'friend'}!`;
      break;
    }
    default: reply = 'Sorry about that — could you repeat that?';
  }

  s.transcript.push({ role: 'agent', text: reply, at: store.now() });
  return { reply, session: s, done: s.state === 'done', intent: s.intent };
}

// ── optional free-LLM polish (Ollama local, zero cost, zero keys) ─────
async function polishWithOllama(systemPrompt, userText, fallback) {
  const host = process.env.OLLAMA_URL;
  if (!host) return fallback;
  try {
    const res = await fetch(host.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
        stream: false,
        options: { temperature: 0.6, num_predict: 80 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const txt = (j.message && j.message.content || '').trim();
    return txt || fallback;
  } catch (e) { return fallback; }
}

module.exports = { newSession, advance, parseWhen, parseService, parseName, parsePhone, fmtWhen, BUSINESS, polishWithOllama };
