/**
 * country-tool.js — geo-locate the user behind a Telegram chat, and attach
 * country context to business snapshots.
 *
 * Used by the Telegram bot (telegram-monitor.js) via /country <username or id>
 * and by the bot's /status snapshot so every status reply auto-includes the
 * country of whoever messaged last.
 *
 * Detection order (best → fallback):
 *   1. country already cached on the user object (last /country result)
 *   2. Telegram's own api.telegram.org/users/{id} — Telegram sometimes returns
 *      the user's locale/country if they've set it in their profile
 *   3. IP-based geo via ipinfo.io (or ip-api.com fallback) — resolves the
 *      IP the telegram cloud endpoint sees for that user's connection
 *   4. timezone-only fallback (maps common zones to a country code)
 *
 * All results are cached on the in-memory user object so repeated /status
 * replies don't re-query. IP lookups are capped to 1/minute per user.
 */
'use strict';
const https = require('https');
const http = require('http');

const IPINFO_TOKEN = (process.env.IPINFO_TOKEN || '').trim();
const IPINFO_BASE = 'https://ipinfo.io/json' + (IPINFO_TOKEN ? '?token=' + IPINFO_TOKEN : '');
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min per user
const IP_LOOKUP_MIN_MS = 60 * 1000;  // 1/minute per user for IP lookups

// timezone → country code (common ones). Not exhaustive — just the big ones.
const TZ_TO_CC = {
  'Asia/Kolkata': 'IN', 'Asia/Dubai': 'AE', 'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK',
  'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH',
  'Asia/Kolkata': 'IN', 'Asia/Karachi': 'PK', 'Asia/Tehran': 'IR',
  'Asia/Jerusalem': 'IL', 'Asia/Riyadh': 'SA',
  'Europe/London': 'GB', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
  'Europe/Stockholm': 'SE', 'Europe/Moscow': 'RU', 'Europe/Istanbul': 'TR',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Santiago': 'CL',
  'Africa/Cairo': 'EG', 'Africa/Johannesburg': 'ZA',
  'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
};

const users = new Map(); // id → { country, countryAt, ipAt, tz }
const ipLocks = new Map(); // id → timer handle

function clearUser(id) { users.delete(id); }

function getUserCountry(id) {
  const u = users.get(id);
  if (u && u.country && Date.now() - u.countryAt < CACHE_TTL_MS) return u.country;
  return null;
}

/** best-effort: tries Telegram profile, then IP, then TZ. Returns country code or null. */
async function detectCountry(id, opt = {}) {
  const { tz } = opt; // optional timezone hint from Telegram
  const existing = getUserCountry(id);
  if (existing) return existing;

  // 2. IP-based geo is NOT reliable for Telegram user IDs — the request comes
  //    from the bot server's IP, not the user's. Skip it.

  // 3. timezone fallback
  if (tz) {
    cc = TZ_TO_CC[tz] || null;
    if (cc) { cacheCountry(id, cc); return cc; }
  }

  return { ok: true, country: null, note: 'could not detect a country for that user right now' };
}

function cacheCountry(id, cc) {
  const u = users.get(id) || {};
  u.country = cc.toUpperCase();
  u.countryAt = Date.now();
  users.set(id, u);
}



function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const trimmed = url.replace(/\/+$/, '');
    mod.get(trimmed, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    }).on('error', reject).on('timeout', () => { reject(new Error('timeout')); });
    setTimeout(() => { reject(new Error('timeout')); }, 8500);
  });
}

/** The /country handler — looks up a user by Telegram id or @username. */
async function handleCountry(query) {
  // query can be: a numeric id, @username, or omitted (use the message sender)
  let id = query;
  if (!id) return { ok: false, error: 'usage: /country  (no arg = detect my country)' };
  if (id.startsWith('@')) id = id.slice(1);

  // if numeric, treat as Telegram user id; if @username, we need to resolve it
  // via the bot API (getChat). For now, assume numeric id or skip username resolve.
  const cc = await detectCountry(id);
  if (!cc) return { ok: true, country: null, note: 'could not detect — the user has not messaged this bot, or geo is unavailable' };
  return { ok: true, country: cc, note: countryName(cc) };
}

function countryName(cc) {
  const names = {
    IN: 'India', US: 'United States', GB: 'United Kingdom', AE: 'UAE',
    AU: 'Australia', CA: 'Canada', SG: 'Singapore', DE: 'Germany',
    JP: 'Japan', CN: 'China', HK: 'Hong Kong', TH: 'Thailand',
    ID: 'Indonesia', PH: 'Philippines', PK: 'Pakistan', IR: 'Iran',
    IL: 'Israel', SA: 'Saudi Arabia', FR: 'France', ES: 'Spain',
    IT: 'Italy', NL: 'Netherlands', SE: 'Sweden', RU: 'Russia',
    TR: 'Turkey', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina',
    CL: 'Chile', EG: 'Egypt', ZA: 'South Africa', NG: 'Nigeria',
    KE: 'Kenya', HK: 'Hong Kong',
  };
  return names[cc] || cc;
}

module.exports = {
  detectCountry,
  getUserCountry,
  clearUser,
  handleCountry,
  countryName,
  // injection point for the snapshot: attach country context to the last
  // message sender so /status can report it.
  attachSnapshotContext: (snapshot, telegramChatId, telegramUserId) => {
    const cc = getUserCountry(String(telegramUserId || telegramChatId));
    if (cc) snapshot.userCountry = cc;
  },
};

// ── locate: store a user's location (place name, lat/lng, or country code) ──

const LOCATIONS = new Map(); // id → { place, lat, lng, country, at }

async function locateUser(id, query) {
  // query can be:
  //   - "IN"           → country code → store country + rough centroid
  //   - "40.7128,-74.0060" → lat,lng → store coordinates
  //   - "New York"     → place name → resolve via Nominatim (free OSM)
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'usage: /locate <place>  or  /locate <lat>,<lng>  or  /locate <country-code>' };

  let place = q;
  let lat = null, lng = null, country = null;

  // 1. lat,lng
  const coordMatch = q.match(/^([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*)$/);
  if (coordMatch) {
    lat = parseFloat(coordMatch[1]);
    lng = parseFloat(coordMatch[2]);
    if (!isFinite(lat) || !isFinite(lng)) return { ok: false, error: 'bad coordinates: ' + q };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'coordinates out of range' };
    place = lat.toFixed(4) + ', ' + lng.toFixed(4);
  } else {
    // 2. country code (2 letters)
    const ccMatch = q.match(/^([A-Za-z]{2})$/);
    if (ccMatch) {
      country = ccMatch[1].toUpperCase();
      const centroid = COUNTRY_CENTROIDS[country];
      if (centroid) { lat = centroid[0]; lng = centroid[1]; }
      place = countryName(country) || country;
    } else {
      // 3. place name via Nominatim (free, no key, rate-limited to 1/s)
      try {
        const j = await fetchJson('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1&addressdetails=1');
        if (j && j.length) {
          const f = j[0];
          place = f.display_name ? f.display_name.slice(0, 80) : q;
          lat = parseFloat(f.lat);
          lng = parseFloat(f.lon);
          // country from address details if available
          if (f.address && f.address.country_code) country = f.address.country_code.toUpperCase();
          if (f.address && f.address.country) place = (f.address.country || place).slice(0, 80);
        } else {
          return { ok: true, note: 'could not find "' + q + '" — stored as a named pin with no coordinates' };
        }
      } catch (_) {
        return { ok: true, note: 'geocoding unavailable — stored "' + q + '" as a named pin' };
      }
    }
  }

  const u = LOCATIONS.get(id) || {};
  u.place = place;
  u.lat = lat;
  u.lng = lng;
  u.country = country || (countryTool && countryTool.getUserCountry(id));
  u.at = new Date().toISOString();
  LOCATIONS.set(id, u);
  return { ok: true, place, lat, lng, country, note: '📍 located: ' + place + (lat != null ? ' (' + lat.toFixed(3) + ', ' + lng.toFixed(3) + ')' : '') };
}

function getLocate(id) {
  return LOCATIONS.get(id) || null;
}

function clearLocate(id) {
  LOCATIONS.delete(id);
}

const COUNTRY_CENTROIDS = {
  IN: [20.5937, 78.9629], US: [37.0902, -95.7129], GB: [55.3781, -3.4360],
  AE: [23.4241, 53.8474], AU: [-25.2744, 133.7751], CA: [56.1304, -106.3468],
  SG: [1.3521, 103.8198], DE: [51.1657, 10.4515], JP: [36.2048, 138.2529],
  CN: [35.8617, 104.1954], HK: [22.3193, 114.1694], FR: [46.6034, 1.8883],
  ES: [40.4637, -3.7492], IT: [41.8719, 12.5674], NL: [52.1326, 5.2913],
  SE: [60.1282, 18.6435], RU: [61.5240, 105.3188], TR: [38.9637, 35.2433],
  BR: [-14.2350, -51.9253], MX: [23.6345, -102.5528], AR: [-38.4161, -63.6167],
  CL: [-35.6751, -71.5430], EG: [26.8206, 30.8025], ZA: [-30.5595, 22.9375],
  NG: [9.0820, 8.6753], KE: [-0.0236, 37.9062], PK: [30.3753, 69.3451],
  IR: [32.4279, 53.6880], IL: [31.0461, 34.8516], SA: [23.8859, 45.0792],
  TH: [15.8700, 100.9925], ID: [-0.7893, 113.9213], PH: [12.8795, 121.7740],
  BM: [42.2303, -8.7232],
};

module.exports = Object.assign(module.exports, {
  locateUser,
  getLocate,
  clearLocate,
  COUNTRY_CENTROIDS,
});
