/**
 * SecondShift — Vapi bridge.
 *
 * Connects Vapi (professional STT, interruption handling, phone lines)
 * to OUR deterministic booking brain (voice-agent.js). The brain still
 * makes every decision — Vapi just supplies better ears and a phone line.
 *
 * Vapi speaks OpenAI `chat/completions`: it POSTs the conversation so far
 * and expects `{ choices: [{ message: { content } }] }` back. This module
 * translates: it finds or creates an agent session for the Vapi call,
 * extracts the latest caller utterance, advances the brain, and persists
 * everything (calls + appointments) exactly like the built-in web agent.
 */
const voice = require('./voice-agent');

// callKey -> { session, createdAt }
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h

function prune() {
  const cut = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) if (v.createdAt < cut) sessions.delete(k);
}
setInterval(prune, 10 * 60 * 1000).unref();

/** Map OpenAI messages to the newest caller utterance. */
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user' && typeof messages[i].content === 'string') {
      return messages[i].content;
    }
  }
  return '';
}

/** Distinct key per Vapi call. */
function callKeyFrom(req) {
  const b = req.body || {};
  return (
    (b.call && (b.call.id || b.call.phoneCallProviderId)) ||
    b.sipCallId ||
    b.id ||
    (b.customer && b.customer.phoneNumber ? 'cust-' + b.customer.phoneNumber : null) ||
    'web-' + Date.now()
  );
}

/**
 * Handle one chat/completions request.
 * Returns the assistant reply string. Throws on unrecoverable errors.
 */
function handleChatCompletion(req, deps) {
  const { saveCall, createAppointment, addEvent } = deps;
  const body = req.body || {};
  const key = callKeyFrom(req);
  const utterance = lastUserMessage(body.messages);

  let entry = sessions.get(key);
  if (!entry) {
    const session = voice.newSession({ channel: 'vapi', vapiCallId: key, userAgent: (req.get('user-agent') || '').slice(0, 120) });
    const { reply: greeting } = voice.advance(session, ''); // prime + capture the opener
    session.transcript = session.transcript.filter((t) => t.text !== '');
    saveCall(session);
    addEvent('call_started', { callId: session.id, channel: 'vapi' });
    entry = { session, greeting, createdAt: Date.now() };
    sessions.set(key, entry);
  }

  const session = entry.session;
  let reply = entry.greeting || null;
  if (utterance) {
    const { reply: r, session: updated, done } = voice.advance(session, String(utterance).slice(0, 500));
    reply = r;
    if (done && updated.slots.service && updated.slots.when && updated.slots.phone) {
      const appt = createAppointment({
        callId: updated.id,
        service: updated.slots.service,
        when: updated.slots.when,
        name: updated.slots.name || 'Caller',
        phone: updated.slots.phone,
      });
      addEvent('appointment_booked', { callId: updated.id, service: updated.slots.service, when: updated.slots.when, channel: 'vapi' });
      entry.appointment = appt;
    }
    saveCall(updated);
  } else {
    // first contact: Vapi asks for the opener — we already captured it
    reply = entry.greeting || 'Hi, thanks for calling Demo Business! I can help with bookings or questions. What can I do for you?';
  }

  entry.lastActivity = Date.now();
  return reply;
}

module.exports = { handleChatCompletion, lastUserMessage, sessions };
