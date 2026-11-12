// SQLite storage: score cache, play log, and each friend's connected accounts.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS score_cache (
      track_id TEXT PRIMARY KEY,
      score REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      played_at TEXT NOT NULL,
      track_id TEXT NOT NULL,
      track TEXT NOT NULL,
      artist TEXT NOT NULL,
      score REAL
    );
    CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      secret TEXT,
      PRIMARY KEY (user_id, provider)
    );
  `);
  return {
    getCachedScore(trackId) {
      return db.prepare('SELECT score, source FROM score_cache WHERE track_id = ?').get(trackId);
    },
    cacheScore(trackId, score, source) {
      db.prepare('INSERT OR REPLACE INTO score_cache (track_id, score, source) VALUES (?, ?, ?)')
        .run(trackId, score, source);
    },
    logPlay({ userId, trackId, track, artist, score }) {
      db.prepare(`INSERT INTO plays (user_id, played_at, track_id, track, artist, score)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(userId, new Date().toISOString(), trackId, track, artist, score);
    },
    lastTrackId(userId) {
      const row = db.prepare('SELECT track_id FROM plays WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
      return row?.track_id ?? null;
    },
    saveConnection(userId, provider, account, secret) {
      db.prepare('INSERT OR REPLACE INTO connections (user_id, provider, account, secret) VALUES (?, ?, ?, ?)')
        .run(userId, provider, account, secret);
    },
    getConnections(userId) {
      return db.prepare('SELECT provider, account, secret FROM connections WHERE user_id = ?').all(userId);
    },
    deleteConnection(userId, provider) {
      db.prepare('DELETE FROM connections WHERE user_id = ? AND provider = ?').run(userId, provider);
    },
    // A friend is tracked once they've signed in with Discord.
    listUsers() {
      return db.prepare("SELECT user_id, account FROM connections WHERE provider = 'discord'").all();
    },
  };
}

module.exports = { openDb };
