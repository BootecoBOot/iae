// metrics.js - simple JSON-backed metrics storage
const fs = require('fs');
const path = require('path');

const METRICS_FILE = path.join(__dirname, 'data', 'metrics.json');

let state = {
  users: {}, // userId -> { firstSeen, lastSeen, count }
  searches: [], // { ts, type, lat, lng, keyword }
  placesShown: {}, // place_id -> { name, vicinity, count }
};

function load() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const raw = fs.readFileSync(METRICS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        state = data;
        // garante chaves padrão mesmo em arquivos antigos
        if (!state.users || typeof state.users !== 'object') state.users = {};
        if (!Array.isArray(state.searches)) state.searches = [];
        if (!state.placesShown || typeof state.placesShown !== 'object') state.placesShown = {};
      }
    }
  } catch (e) {
    // ignore
  }
}

function save() {
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    // ignore
  }
}

function init() {
  load();
  // periodic flush
  setInterval(save, 10000);
}

function recordUser(userId) {
  const now = Date.now();
  if (!state.users[userId]) {
    state.users[userId] = { firstSeen: now, lastSeen: now, count: 1 };
  } else {
    state.users[userId].lastSeen = now;
    state.users[userId].count += 1;
  }
}

function recordSearch({ type, lat, lng, keyword }) {
  const ts = Date.now();
  state.searches.push({ ts, type: type || 'unknown', lat: Number(lat) || null, lng: Number(lng) || null, keyword: keyword || '' });
  // cap to last 50k entries to avoid file bloat
  if (state.searches.length > 50000) state.searches = state.searches.slice(-30000);
}

function recordPlaceShown({ place_id, name, vicinity }) {
  if (!place_id) return;
  const cur = state.placesShown[place_id] || { name: name || '', vicinity: vicinity || '', count: 0 };
  cur.name = name || cur.name;
  cur.vicinity = vicinity || cur.vicinity;
  cur.count += 1;
  state.placesShown[place_id] = cur;
}

function getSummary() {
  const totalUsers = Object.keys(state.users).length;
  const totalSearches = state.searches.length;
  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const searches24h = state.searches.filter(s => s.ts >= last24h).length;
  return { totalUsers, totalSearches, searches24h };
}

function getTimeSeries({ hours = 24 }) {
  const now = Date.now();
  const bucketMs = 60 * 60 * 1000; // 1h
  const buckets = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = now - i * bucketMs;
    const end = start + bucketMs;
    const count = state.searches.filter(s => s.ts >= start && s.ts < end).length;
    buckets.push({ t: start, count });
  }
  return buckets;
}

function getHeatmap({ hours = 24 }) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  // return [ [lat, lng, intensity], ... ]
  return state.searches
    .filter(s => s.ts >= since && s.lat && s.lng)
    .map(s => [s.lat, s.lng, 0.5]);
}

function getTop({ limit = 10 }) {
  const freq = {};
  for (const s of state.searches) {
    const k = (s.keyword || '').toLowerCase().trim();
    if (!k) continue;
    freq[k] = (freq[k] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}

function getTopPlaces({ limit = 10 }) {
  return Object.entries(state.placesShown || {})
    .map(([place_id, info]) => ({ place_id, name: info.name, vicinity: info.vicinity, count: info.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function getPlaceShownCounts() {
  // returns map: place_id -> count
  const out = {};
  for (const [pid, info] of Object.entries(state.placesShown || {})) {
    out[pid] = info?.count || 0;
  }
  return out;
}

module.exports = {
  init,
  recordUser,
  recordSearch,
  recordPlaceShown,
  getSummary,
  getTimeSeries,
  getHeatmap,
  getTop,
  getTopPlaces,
  getPlaceShownCounts,
};
