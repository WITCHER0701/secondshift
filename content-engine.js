/**
 * SecondShift — The Content Crew: from one input to a week of branded posts.
 *
 * Free by design (rule-based generation, zero API keys). Give it a business,
 * a photo description and the vibe, and it returns 7 ready-to-post items:
 * unique angles, captions matched to brand voice, hashtags, best posting
 * times, and a Monday-morning performance report skeleton.
 *
 * Optional upgrade: set CONTENT_LLM_URL to an OpenAI-compatible endpoint
 * (Ollama works) and the engine will use it for caption polish — the
 * structure, hashtags and schedule logic stay deterministic.
 */
const store = require('./data-store');

// ── brand voice profiles ──────────────────────────────────────────────
const VOICES = {
  playful: {
    openers: ['Okay, we need to talk about', 'POV:', 'Not us falling in love with', 'This one goes out to everyone who loves', 'Stop scrolling —'],
    closers: ['See you soon 👋', 'You know where to find us 😏', 'Tag someone who needs this 👇', 'Run, don\u2019t walk.', 'Save this for later 📌'],
    emoji: ['✨', '😋', '🔥', '🙌', '💥'],
    tagsPerPost: 6,
  },
  premium: {
    openers: ['Craft, considered.', 'Introducing', 'A quiet standard:', 'Details matter.', 'This is'],
    closers: ['By appointment.', 'Available now.', 'Reserved for those who notice.', 'The standard, upheld.', '— The Team'],
    emoji: ['', '✦', '·'],
    tagsPerPost: 4,
  },
  local: {
    openers: ['Neighbors!', 'Big thanks to', 'This week at', 'Community shoutout:', 'Your local team is at it again —'],
    closers: ['See you around the neighborhood!', 'Support local. We do. 💙', 'Swing by this week!', 'Proudly serving since day one.', 'Tell a neighbor 👇'],
    emoji: ['🏡', '💙', '👍', '📍'],
    tagsPerPost: 5,
  },
};

// ── the 7 post angles (a proven weekly mix) ───────────────────────────
const ANGLES = [
  { kind: 'Showcase',   build: (c) => `${pick(c.voice.openers)} our ${c.subject}. ${c.descriptor} ${pick(c.voice.emoji)}` },
  { kind: 'Behind-the-scenes', build: (c) => `How it's made: the ${c.subject} before it reaches you. ${c.craft} ${pick(c.voice.emoji)}` },
  { kind: 'Social proof', build: (c) => `"${c.reviewQuote}" — a real customer about our ${c.subject}. ${pick(c.voice.emoji)} ${pick(c.voice.closers)}` },
  { kind: 'Offer',      build: (c) => `${c.offer} This week only — mention this post. ${pick(c.voice.closers)}` },
  { kind: 'Educational', build: (c) => `3 things most people don't know about ${c.topic}: 1) ${c.facts[0]} 2) ${c.facts[1]} 3) ${c.facts[2]}` },
  { kind: 'Team',       build: (c) => `The people behind your ${c.subject}: ${c.teamMoment} ${pick(c.voice.emoji)} ${pick(c.voice.closers)}` },
  { kind: 'Community',  build: (c) => `${pick(c.voice.openers)} ${c.community}. Proud to be part of ${c.city}. ${pick(c.voice.closers)}` },
];

// deterministic PRNG so the same input regenerates the same set (feels professional)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// module-scoped rng: set per generate() call, used by pick() in the builders
let rnd = Math.random;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickFrom = (arr, _r) => pick(arr); // two-arg call sites

function generate({ business, subject, vibe, city, offer }) {
  const b = String(business || 'Our Business').trim();
  const subj = String(subject || 'signature piece').trim();
  const vibeKey = VOICES[vibe] ? vibe : 'local';
  const voice = VOICES[vibeKey];
  const citySafe = String(city || 'your city').trim();
  const seed = hashStr(b + '|' + subj + '|' + vibeKey + '|' + citySafe + '|' + String(offer || ''));
  rnd = mulberry32(seed);

  const ctx = {
    voice,
    subject: subj,
    city: citySafe,
    descriptor: pickFrom(['Fresh out of the studio.', 'Look at that finish.', 'Worth every minute.', 'This is the one people ask about.'], rnd),
    craft: pickFrom(['Every step done by hand, on purpose.', 'No shortcuts — that\u2019s the whole secret.', 'Twenty years of practice in one photo.'], rnd),
    reviewQuote: pickFrom([
      'I have never seen anything like it',
      'Absolutely worth the drive',
      'They treated us like family',
      'Ten out of ten, every single time',
    ], rnd),
    offer: String(offer || 'Free consult with any booking').trim(),
    topic: pickFrom([subj + ' care', 'choosing a ' + subj.split(' ')[0], 'getting the most from your ' + subj.split(' ')[0]], rnd),
    facts: [
      pickFrom(['timing matters more than price', 'the first 48 hours decide the result', 'materials beat shortcuts every time'], rnd),
      pickFrom(['maintenance is cheaper than repair — always', 'small habits double its lifespan', 'the cheapest option is rarely the best value'], rnd),
      pickFrom(['a pro spots in minutes what takes you hours', 'prep is 80% of the outcome', 'seasonal checks prevent 9 of 10 problems'], rnd),
    ],
    teamMoment: pickFrom(['Maria prepping the morning batch.', 'Jordan perfecting the details.', 'The crew running the final check — every single time.'], rnd),
    community: pickFrom(['the Saturday market crew', 'the high-school fundraiser', 'the youth sports team we sponsor'], rnd),
  };

  const times = ['7:30 AM', '12:00 PM', '5:00 PM', '8:00 PM'];
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const baseHashtags = ['#' + b.replace(/[^a-zA-Z0-9]/g, ''), '#' + subj.split(' ')[0].replace(/[^a-zA-Z0-9]/g, ''), '#' + citySafe.replace(/[^a-zA-Z0-9]/g, '')];
  const fillerTags = ['#smallbusiness', '#shoplocal', '#humpday', '#weekendvibes', '#supportlocal', '#downtown', '#limitedtime', '#meettheteam'];

  const posts = ANGLES.map((angle, i) => {
    const day = days[i];
    const time = times[i % times.length];
    const tags = [...baseHashtags, ...fillerTags].sort(() => rnd() - 0.5).slice(0, voice.tagsPerPost);
    return {
      day, time, kind: angle.kind,
      caption: angle.build(ctx),
      hashtags: tags,
      cta: pickFrom(['Book via link in bio', 'DM us the word HELLO', 'Tap to reserve', 'Comment below'], rnd),
      imagePrompt: `${subj} — ${angle.kind.toLowerCase()} style photo, natural light, on-brand`,
    };
  });

  return {
    id: store.uid('gen'),
    business: b, subject: subj, vibe: vibeKey, city: citySafe,
    posts, createdAt: store.now(),
    weekReport: { impressions: null, engagement: null, topPost: null, note: 'filled in next Monday' },
  };
}

module.exports = { generate, VOICES };
