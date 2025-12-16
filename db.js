const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data', 'data.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    wa_jid TEXT PRIMARY KEY,
    name TEXT,
    style TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_jid TEXT,
    role TEXT,
    message TEXT,
    ts INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
    wa_jid TEXT,
    pref_key TEXT,
    pref_value TEXT,
    updated_at INTEGER,
    PRIMARY KEY (wa_jid, pref_key)
  )`);
});

function now() { return Date.now(); }

function saveMessage(wa_jid, role, message, ts = now()) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO conversations (wa_jid, role, message, ts) VALUES (?,?,?,?)`,
      [wa_jid, role, String(message || ''), ts],
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });
}

function upsertUser(wa_jid, fields = {}) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT wa_jid FROM users WHERE wa_jid = ?`, [wa_jid], (err, row) => {
      if (err) return reject(err);
      const t = now();
      if (row) {
        const name = fields.name ?? null;
        const style = fields.style ?? null;
        db.run(
          `UPDATE users SET name = COALESCE(?, name), style = COALESCE(?, style), updated_at = ? WHERE wa_jid = ?`,
          [name, style, t, wa_jid],
          function (e) { if (e) reject(e); else resolve(true); }
        );
      } else {
        db.run(
          `INSERT INTO users (wa_jid, name, style, created_at, updated_at) VALUES (?,?,?,?,?)`,
          [wa_jid, fields.name ?? null, fields.style ?? null, t, t],
          function (e) { if (e) reject(e); else resolve(true); }
        );
      }
    });
  });
}

function getRecentConversation(wa_jid, limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT role, message, ts FROM conversations WHERE wa_jid = ? ORDER BY ts DESC LIMIT ?`,
      [wa_jid, limit],
      (err, rows) => {
        if (err) reject(err); else resolve((rows || []).reverse());
      }
    );
  });
}

function getUser(wa_jid) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE wa_jid = ?`, [wa_jid], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });
}

function setUserPref(wa_jid, key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO user_preferences (wa_jid, pref_key, pref_value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(wa_jid, pref_key) DO UPDATE SET pref_value = excluded.pref_value, updated_at = excluded.updated_at`,
      [wa_jid, key, String(value ?? ''), now()],
      function (err) { if (err) reject(err); else resolve(true); }
    );
  });
}

function upsertManyPrefs(wa_jid, obj = {}) {
  const entries = Object.entries(obj);
  return Promise.all(entries.map(([k, v]) => setUserPref(wa_jid, k, v))).then(() => true);
}

function getUserPrefs(wa_jid) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT pref_key, pref_value FROM user_preferences WHERE wa_jid = ?`, [wa_jid], (err, rows) => {
      if (err) return reject(err);
      const out = {};
      for (const r of rows || []) out[r.pref_key] = r.pref_value;
      resolve(out);
    });
  });
}

function getUserStats({ days = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const since = now() - days * 24 * 60 * 60 * 1000;
    db.all(
      `SELECT
         COUNT(*)                  AS totalUsers,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS newUsersPeriod,
         MIN(created_at)           AS firstUserTs,
         MAX(updated_at)           AS lastUserTs
       FROM users`,
      [since],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows && rows[0] ? rows[0] : { totalUsers: 0, newUsersPeriod: 0, firstUserTs: null, lastUserTs: null });
      }
    );
  });
}

function getUserTimeSeries({ days = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const since = now() - days * 24 * 60 * 60 * 1000;
    db.all(
      `SELECT
         strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch')) AS day,
         COUNT(*) AS newUsers
       FROM users
       WHERE created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
      [since],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function getConversationStats({ days = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const since = now() - days * 24 * 60 * 60 * 1000;
    db.all(
      `SELECT
         COUNT(*) AS totalMessages,
         SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS messagesPeriod
       FROM conversations`,
      [since],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows && rows[0] ? rows[0] : { totalMessages: 0, messagesPeriod: 0 });
      }
    );
  });
}

function getConversationTimeSeries({ days = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const since = now() - days * 24 * 60 * 60 * 1000;
    db.all(
      `SELECT
         strftime('%Y-%m-%d', datetime(ts / 1000, 'unixepoch')) AS day,
         COUNT(*) AS messages
       FROM conversations
       WHERE ts >= ?
       GROUP BY day
       ORDER BY day ASC`,
      [since],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// Usuários ativos (com pelo menos uma mensagem) no período e no dia atual
function getActiveUserStats({ days = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const nowTs = now();
    const sincePeriod = nowTs - days * 24 * 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const sinceToday = startOfToday.getTime();

    db.all(
      `SELECT
         COUNT(DISTINCT CASE WHEN ts >= ? THEN wa_jid END) AS activeToday,
         COUNT(DISTINCT CASE WHEN ts >= ? THEN wa_jid END) AS activePeriod
       FROM conversations`,
      [sinceToday, sincePeriod],
      (err, rows) => {
        if (err) return reject(err);
        const row = rows && rows[0] ? rows[0] : { activeToday: 0, activePeriod: 0 };
        resolve({
          activeToday: Number(row.activeToday || 0),
          activePeriod: Number(row.activePeriod || 0),
        });
      }
    );
  });
}

// Últimos usuários (ordenados por updated_at desc)
function getRecentUsers({ limit = 10 } = {}) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT wa_jid, name, created_at, updated_at
       FROM users
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

module.exports = { db, saveMessage, upsertUser, getRecentConversation, getUser, setUserPref, upsertManyPrefs, getUserPrefs, getUserStats, getUserTimeSeries, getConversationStats, getConversationTimeSeries, getActiveUserStats, getRecentUsers };
