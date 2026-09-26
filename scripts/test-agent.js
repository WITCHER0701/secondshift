/**
 * Headless Codebuff probe — standalone one-shot.
 * Uses the SAME agent + auth path as the Telegram /agent relay
 * (agent-runner.js), so what passes here is what Telegram will run.
 * Safe to delete once the relay is proven.
 */
const runner = require('../agent-runner');

if (!runner.enabled) {
  console.log('NOT-ACTIVE: no Codebuff auth found on this PC');
  process.exit(2);
}

console.log('runner active · model', runner.AGENT_MODEL, '· timeout', Math.round(runner.TIMEOUT_MS / 60000) + 'm');
runner.runTask('Health ping: reply with exactly AGENT-OK and nothing else. Do not read or modify any files.', {
  onUpdate: (m) => console.log('UPDATE:', m),
}).then((r) => {
  console.log('ok:', r.ok, '· durationMs:', r.durationMs);
  console.log('text:', r.text);
  process.exit(r.ok ? 0 : 1);
}).catch((e) => { console.error('CRASH:', e && (e.message || e)); process.exit(1); });
