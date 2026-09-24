#!/usr/bin/env node
/**
 * Voice agent E2E smoke test — run while the server is up:
 *   node scripts/voice-e2e.js
 * Drives a full booking conversation over the public API, then verifies
 * the call + appointment landed in the admin API.
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lab-admin-2026';

async function post(path, body, cookie) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
}
async function get(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
  let ok = true;
  const log = (pass, label, extra) => console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')) || (pass || (ok = false));

  // 1. start a call
  const start = await post('/api/voice/start', { channel: 'e2e-test' });
  const callId = start.data && start.data.callId;
  log(start.status === 200 && !!callId, 'call starts', callId);
  log(/bookings or questions|help you/i.test(start.data.reply || ''), 'greeting plays');

  // 2. full booking conversation
  const turns = [
    ['I want to book a haircut', /haircut/i],
    ['Saturday at 11am', /saturday/i],
    ['Priya Patel', /name|priya|phone/i],
    ['555 867 5309', /book/i],
    ['yes', /booked/i],
  ];
  let last = start.data;
  for (const [text, expect] of turns) {
    last = await post('/api/voice/turn', { callId, text });
    log(last.status === 200 && expect.test(last.data.reply || ''), `turn "${text}"`, (last.data.reply || '').slice(0, 80));
  }
  log(last.data.done === true, 'conversation completes');

  // 3. session persistence
  const sess = await get('/api/voice/session/' + callId);
  const s = sess.data && sess.data.session;
  log(!!s && s.slots.service === 'haircut' && s.slots.phone === '5558675309' && s.transcript.length === 11, 'session + transcript persisted');

  // 4. appointment + call visible via admin API
  const login = await post('/admin/login', { password: ADMIN_PASSWORD });
  const cookie = (login.cookie || '').split(';')[0];
  log(login.status === 200, 'admin login');
  const appts = await get('/api/voice/appointments', cookie);
  const mine = (appts.data.appointments || []).find(a => a.callId === callId);
  log(!!mine, 'appointment saved', mine ? mine.service + ' for ' + mine.name : 'not found');
  const calls = await get('/api/voice/calls', cookie);
  log((calls.data.calls || []).some(c => c.id === callId), 'call record saved');

  console.log(ok ? '\nVOICE_E2E_PASS' : '\nVOICE_E2E_FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
