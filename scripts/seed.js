/**
 * Seeds the SecondShift catalog — the crew of automations you sell.
 * Edit this file to add your offerings — the whole site is data-driven from here.
 */
const store = require('../data-store');

const CATALOG = [
  {
    slug: 'review-automation',
    name: 'Reviews',
    tagline: 'Every happy customer asks for it. You never do.',
    icon: '⭐',
    accent: '#f59e0b',
    price: 750,
    priceLabel: '$750/mo',
    sellTo: 'Restaurants, salons, auto repair shops',
    outcome: 'Google profile goes from 14 reviews to 200+. Rankings climb, phones ring.',
    bullets: [
      'Claude writes a personal SMS the second a job is completed',
      'Rating gate: 4-5★ go to Google, 1-3★ become private feedback',
      'Two gentle automatic follow-ups if customers don\u2019t respond',
      'Owner dashboard with sends, clicks, ratings and captured feedback',
      'POS/booking webhook API (Square, Toast, Booksy, custom)',
    ],
    steps: [
      { title: 'Service completed', desc: 'POS fires a webhook (or staff taps "Complete" in the dashboard).' },
      { title: 'Claude writes the message', desc: 'A warm, personal review request — unique every time.' },
      { title: 'Customer taps the link', desc: 'One tap from the text message. No app, no login.' },
      { title: 'Rating gate', desc: 'Happy customers land on Google. Unhappy ones tell you privately.' },
      { title: 'Follow-ups & analytics', desc: 'Non-responders get nudged. Everything lands in the dashboard.' },
    ],
    demo: { kind: 'review-gate', headline: 'Try the rating gate yourself', sub: 'Tap a star. Watch where a happy customer goes — and where an unhappy one is intercepted.' },
    order: 1,
  },
  {
    slug: 'voice-agent',
    name: 'The Voice',
    tagline: 'The phone always gets answered. Even at 2am.',
    icon: '📞',
    accent: '#3b82f6',
    price: 1200,
    priceLabel: '$1,200/mo',
    sellTo: 'Clinics, home services, law firms',
    outcome: 'After-hours calls become booked jobs instead of lost customers.',
    bullets: [
      'Natural conversation with your business\u2019s knowledge',
      'Books, reschedules and confirms appointments',
      'Answers pricing & FAQ questions instantly',
      'Sends you a transcript + summary after every call',
      'Human takeover whenever you want it',
    ],
    steps: [
      { title: 'Call comes in', desc: 'Any hour, any volume — the Voice picks up in two rings.' },
      { title: 'AI understands intent', desc: 'Booking, question or emergency — routed intelligently.' },
      { title: 'Action taken', desc: 'Appointment booked, question answered, or owner alerted.' },
      { title: 'You get the summary', desc: 'Transcript, outcome and next steps in your inbox.' },
    ],
    demo: { kind: 'script', headline: 'Hear how a call flows', sub: 'Press play and read a real transcript as the Voice works.' },
    order: 2,
  },
  {
    slug: 'content-engine',
    name: 'The Content Crew',
    tagline: 'A month of social posts from one photo.',
    icon: '🎨',
    accent: '#a855f7',
    price: 499,
    priceLabel: '$499/mo',
    sellTo: 'E-commerce brands, restaurants, gyms',
    outcome: 'Consistent daily posting without hiring a content team.',
    bullets: [
      'One product photo becomes a week of branded posts',
      'AI captions matched to your brand voice',
      'Auto-publishes to Instagram & Facebook',
      'You approve everything with one tap',
      'Performance report every Monday',
    ],
    steps: [
      { title: 'Upload a photo', desc: 'Phone snap is enough — AI does the studio work.' },
      { title: 'AI generates the set', desc: 'Scenes, captions, hashtags — on-brand.' },
      { title: 'One-tap approval', desc: 'Review the week in 60 seconds from Telegram.' },
      { title: 'Auto-published', desc: 'Goes live on schedule. You get the numbers Monday.' },
    ],
    demo: { kind: 'script', headline: 'See a week get created', sub: 'Step through how one photo becomes seven posts.' },
    order: 3,
  },
  {
    slug: 'lead-responder',
    name: 'First Response',
    tagline: 'Every inquiry answered in 30 seconds.',
    icon: '⚡',
    accent: '#10b981',
    price: 600,
    priceLabel: '$600/mo',
    sellTo: 'Real estate, contractors, dealerships',
    outcome: '78% of customers buy from whoever replies first. Now that\u2019s always you.',
    bullets: [
      'Instant AI reply to every form, DM and email lead',
      'Qualifies budget, timeline and intent automatically',
      'Books straight into your calendar',
      'Hands hot leads to you with a full brief',
      'Never lets a lead go cold again',
    ],
    steps: [
      { title: 'Lead arrives', desc: 'From your website, Zillow, Facebook — anywhere.' },
      { title: 'First Response replies in seconds', desc: 'Personal, helpful, on-brand — not a robotic auto-reply.' },
      { title: 'Qualified & booked', desc: 'Serious buyers get calendar links; tire-kickers get nurturing.' },
      { title: 'You close', desc: 'You only talk to people who are ready.' },
    ],
    demo: { kind: 'script', headline: 'Watch a lead get saved', sub: 'A 9pm inquiry becomes a booked appointment by 9:01.' },
    order: 4,
  },
];

function seed() {
  for (const a of CATALOG) store.upsertAutomation(a);
  console.log(`Seeded ${CATALOG.length} automations.`);
}

if (require.main === module) seed();
module.exports = { seed, CATALOG };
