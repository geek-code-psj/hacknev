'use strict';
/**
 * Persistent memory store using sql.js (pure-JS SQLite, no native build).
 * Database is serialised to disk after every write so data survives restarts.
 */
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../../data/memory.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;

function getDb() {
  if (!_db) throw new Error('Memory store not initialised — call store.init() first');
  return _db;
}

function persist() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  _db.run(`
    CREATE TABLE IF NOT EXISTS session_memory (
      userId    TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      summary   TEXT NOT NULL,
      metrics   TEXT NOT NULL DEFAULT '{}',
      tags      TEXT NOT NULL DEFAULT '[]',
      storedAt  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, sessionId)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_user ON session_memory(userId);
    CREATE TABLE IF NOT EXISTS behavioral_profiles (
      userId      TEXT PRIMARY KEY,
      profile     TEXT NOT NULL,
      generatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  persist();
  return _db;
}

function putSession(userId, sessionId, { summary, metrics, tags = [] }) {
  getDb().run(
    `INSERT INTO session_memory (userId,sessionId,summary,metrics,tags,storedAt)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(userId,sessionId) DO UPDATE SET
       summary=excluded.summary,metrics=excluded.metrics,
       tags=excluded.tags,storedAt=datetime('now')`,
    [userId, sessionId,
     typeof summary === 'string' ? summary : JSON.stringify(summary),
     JSON.stringify(metrics), JSON.stringify(tags)]
  );
  persist();
}

function getSession(userId, sessionId) {
  const res = getDb().exec(
    `SELECT * FROM session_memory WHERE userId=? AND sessionId=?`, [userId, sessionId]
  );
  if (!res.length || !res[0].values.length) return null;
  return toSession(res[0].columns, res[0].values[0]);
}

function getContext(userId, relevantTo) {
  const res = getDb().exec(
    `SELECT * FROM session_memory WHERE userId=? ORDER BY storedAt DESC LIMIT 20`, [userId]
  );
  const rows = res.length ? res[0].values.map(v => toSession(res[0].columns, v)) : [];
  const sig  = (relevantTo || '').toLowerCase();
  const scored = rows
    .map(r => ({ r, score: sig && r.tags.some(t => t.toLowerCase().includes(sig)) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score);
  const sessions   = scored.slice(0, 5).map(x => x.r);
  const patternIds = [...new Set(rows.flatMap(r => r.tags.filter(t => t.startsWith('pattern:'))))];
  return { sessions, patternIds };
}

function toSession(cols, vals) {
  const o = {};
  cols.forEach((c, i) => o[c] = vals[i]);
  let summary = o.summary;
  try { summary = JSON.parse(o.summary); } catch {}
  return {
    userId: o.userId, sessionId: o.sessionId, summary,
    metrics: JSON.parse(o.metrics || '{}'),
    tags:    JSON.parse(o.tags    || '[]'),
    storedAt: o.storedAt,
  };
}

function putProfile(userId, profile) {
  getDb().run(
    `INSERT INTO behavioral_profiles(userId,profile,generatedAt)VALUES(?,?,datetime('now'))
     ON CONFLICT(userId) DO UPDATE SET profile=excluded.profile,generatedAt=datetime('now')`,
    [userId, JSON.stringify(profile)]
  );
  persist();
}

function getProfile(userId) {
  const res = getDb().exec(`SELECT * FROM behavioral_profiles WHERE userId=?`, [userId]);
  if (!res.length || !res[0].values.length) return null;
  const o = {};
  res[0].columns.forEach((c, i) => o[c] = res[0].values[0][i]);
  return { userId: o.userId, ...JSON.parse(o.profile), generatedAt: o.generatedAt };
}

module.exports = { init, putSession, getSession, getContext, putProfile, getProfile };
