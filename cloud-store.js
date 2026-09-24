/**
 * SecondShift cloud sync — free-tier cloud persistence.
 *
 * Design: the local JSON file stays the working copy (fast, zero deps).
 * Every save is pushed (debounced) to a free cloud provider; on boot the
 * cloud copy is pulled and restored if it is NEWER than local. One source
 * of truth that survives machine changes and hosting moves — with the site
 * fully functional when no cloud is configured (local-only mode).
 *
 * Providers (both free, pick one — auto-detected from env):
 *
 *   1. GitHub Gist (recommended) — one secret token, no card, no e-mail
 *      verification of an app, generous limits, ideal for one JSON blob.
 *      Needs:  CLOUD_GIST_TOKEN   (classic PAT with "gist" scope)
 *              CLOUD_GIST_ID      (created automatically on first push)
 *
 *   2. Firebase Realtime Database — deep free tier (Spark), no card needed.
 *      Needs:  FIREBASE_DB_URL     (https://<proj>-default-rtdb.firebaseio.com)
 *              FIREBASE_DB_SECRET  (legacy DB secret, or none if rules allow)
 *
 *   Both unset → local-only mode (current behavior, zero friction).
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.SECONDSHIFT_DB || path.join(__dirname, 'data', 'lab.json');

// ── provider detection ────────────────────────────────────────────────
function detectProvider() {
  if (process.env.CLOUD_GIST_TOKEN) return 'gist';
  if (process.env.FIREBASE_DB_URL) return 'firebase';
  return 'local';
}
const provider = detectProvider();
const enabled = provider !== 'local';

const state = {
  provider,
  enabled,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  pushes: 0,
  pulls: 0,
  remoteUpdatedAt: null,
};

// ── debounce: coalesce bursts of saves into one upload ────────────────
const DEBOUNCE_MS = 4000;
let pushTimer = null;
let pendingPayload = null;
function schedulePush(payload) {
  if (!enabled) return;
  pendingPayload = payload;
  if (pushTimer) return; // already scheduled
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = pendingPayload;
    pendingPayload = null;
    doPush(data).catch((e) => {
      state.lastError = String(e.message || e);
    });
  }, DEBOUNCE_MS);
}

// ── GitHub Gist adapter ───────────────────────────────────────────────
async function gistPush(json) {
  const token = process.env.CLOUD_GIST_TOKEN;
  const id = process.env.CLOUD_GIST_ID;
  const body = {
    files: { 'lab.json': { content: json } },
  };
  const res = id
    ? await fetch('https://api.github.com/gists/' + id, {
        method: 'PATCH',
        headers: ghHeaders(token),
        body: JSON.stringify(body),
      })
    : await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: ghHeaders(token),
        body: JSON.stringify({ description: 'SecondShift data (auto-synced)', public: false, ...body }),
      });
  if (!res.ok) throw new Error('gist push failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  // echo the created id so the user can copy it into .env once
  if (!id && j.id) {
    console.log('\n[cloud] First push done. Add this line to .env to reuse the same store:\n');
    console.log('        CLOUD_GIST_ID=' + j.id + '\n');
    process.env.CLOUD_GIST_ID = j.id;
  }
  return j;
}
async function gistPull() {
  const token = process.env.CLOUD_GIST_TOKEN;
  const id = process.env.CLOUD_GIST_ID;
  if (!id) return null; // nothing created yet
  const res = await fetch('https://api.github.com/gists/' + id, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error('gist pull failed: ' + res.status);
  const j = await res.json();
  const f = j.files && j.files['lab.json'];
  return f && f.content ? { content: f.content, updatedAt: j.updated_at } : null;
}
function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'secondshift-sync',
  };
}

// ── Firebase adapter ──────────────────────────────────────────────────
async function fbPush(json) {
  const base = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
  const url = base + '/secondshift.json' + (process.env.FIREBASE_DB_SECRET ? '?auth=' + process.env.FIREBASE_DB_SECRET : '');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: JSON.parse(json), updatedAt: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error('firebase push failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
}
async function fbPull() {
  const base = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
  const url = base + '/secondshift.json' + (process.env.FIREBASE_DB_SECRET ? '?auth=' + process.env.FIREBASE_DB_SECRET : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error('firebase pull failed: ' + res.status);
  const j = await res.json();
  return j && j.data ? { content: JSON.stringify(j.data), updatedAt: j.updatedAt } : null;
}

// ── public API ────────────────────────────────────────────────────────
async function doPush(jsonString) {
  if (!enabled) return { pushed: false, reason: 'local mode' };
  if (provider === 'gist') await gistPush(jsonString);
  else if (provider === 'firebase') await fbPush(jsonString);
  state.lastPushAt = new Date().toISOString();
  state.pushes++;
  state.lastError = null;
  return { pushed: true };
}

async function pushNow(jsonString) {
  // immediate, undebounced push (admin button / boot)
  return doPush(jsonString);
}

/**
 * On boot: pull the cloud copy. If it is newer than the local file,
 * restore it (newest-wins) and report so the server can log it.
 */
async function restoreIfNewer() {
  if (!enabled) return { restored: false, reason: 'local mode' };
  let remote = null;
  try {
    remote = provider === 'gist' ? await gistPull() : await fbPull();
  } catch (e) {
    state.lastError = String(e.message || e);
    return { restored: false, reason: 'pull failed: ' + state.lastError };
  }
  if (!remote || !remote.content) return { restored: false, reason: 'cloud empty (first run)' };
  const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
  const localTime = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).mtimeMs : 0;
  state.remoteUpdatedAt = remote.updatedAt || null;
  if (remoteTime > localTime) {
    // back up local, then restore cloud copy
    if (fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE + '.local-backup', fs.readFileSync(DB_FILE));
    fs.writeFileSync(DB_FILE, remote.content);
    state.lastPullAt = new Date().toISOString();
    state.pulls++;
    return { restored: true, remoteUpdatedAt: remote.updatedAt };
  }
  return { restored: false, reason: 'local is newer (or equal) — keeping local' };
}

function status() {
  return { ...state, enabled, provider };
}

module.exports = { schedulePush, pushNow, restoreIfNewer, status, provider, enabled };
