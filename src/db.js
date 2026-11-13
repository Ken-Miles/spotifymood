// SQLite storage: score cache, play log, and each friend's connected accounts.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { songKey } = require('./scoring');

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
    CREATE TABLE IF NOT EXISTS playlist_meta (
      playlist_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      total INTEGER NOT NULL DEFAULT 0,
      songs_total INTEGER,
      songs_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_playlists (
      user_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (user_id, playlist_id)
    );
    CREATE TABLE IF NOT EXISTS song_links (
      song_key TEXT PRIMARY KEY,
      spotify_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlist_songs (
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      track TEXT NOT NULL,
      artist TEXT NOT NULL,
      PRIMARY KEY (playlist_id, position)
    );
    CREATE TABLE IF NOT EXISTS discord_events (
      id INTEGER PRIMARY KEY,
      received_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      application_id TEXT,
      event_timestamp TEXT,
      payload TEXT NOT NULL
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
    // Playlist name, cover and track count, kept for autocomplete and quick lookups.
    savePlaylistMeta(id, { name, image, total }) {
      db.prepare(`INSERT INTO playlist_meta (playlist_id, name, image, total) VALUES (?, ?, ?, ?)
                  ON CONFLICT(playlist_id) DO UPDATE SET name = excluded.name, image = excluded.image, total = excluded.total`)
        .run(id, name, image ?? null, total);
    },
    // Replaces a user's playlist list with `playlists` (each { id, name, image, total }).
    saveUserPlaylists(userId, playlists, syncedAt) {
      db.exec('BEGIN');
      try {
        for (const p of playlists) {
          this.savePlaylistMeta(p.id, p);
          db.prepare(`INSERT INTO user_playlists (user_id, playlist_id, synced_at) VALUES (?, ?, ?)
                      ON CONFLICT(user_id, playlist_id) DO UPDATE SET synced_at = excluded.synced_at`)
            .run(userId, p.id, syncedAt);
        }
        const keep = playlists.map((p) => p.id);
        const current = db.prepare('SELECT playlist_id FROM user_playlists WHERE user_id = ?').all(userId);
        for (const r of current) {
          if (!keep.includes(r.playlist_id)) {
            db.prepare('DELETE FROM user_playlists WHERE user_id = ? AND playlist_id = ?').run(userId, r.playlist_id);
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    listUserPlaylists(userId) {
      return db.prepare(`SELECT m.playlist_id, m.name, m.image, m.total FROM user_playlists u
                         JOIN playlist_meta m ON m.playlist_id = u.playlist_id
                         WHERE u.user_id = ? ORDER BY m.name COLLATE NOCASE`).all(userId);
    },
    userPlaylistsSyncedAt(userId) {
      return db.prepare('SELECT MAX(synced_at) AS at FROM user_playlists WHERE user_id = ?').get(userId).at;
    },
    // Remembers a song's Spotify track ID, so its title can link to Spotify.
    saveSongLink(key, spotifyId) {
      db.prepare('INSERT OR REPLACE INTO song_links (song_key, spotify_id) VALUES (?, ?)').run(key, spotifyId);
    },
    // Spotify URL for a song, or undefined if no Spotify ID has been seen for it.
    getSongLink(key) {
      const row = db.prepare('SELECT spotify_id FROM song_links WHERE song_key = ?').get(key);
      return row ? `https://open.spotify.com/track/${row.spotify_id}` : undefined;
    },
    getPlaylistMeta(id) {
      return db.prepare('SELECT playlist_id, name, image, total FROM playlist_meta WHERE playlist_id = ?').get(id) ?? null;
    },
    // Stores a playlist's songs in order, along with the track count they were fetched for.
    savePlaylistSongs(id, tracks, total) {
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE playlist_meta SET songs_total = ?, songs_synced_at = ? WHERE playlist_id = ?')
          .run(total, new Date().toISOString(), id);
        db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(id);
        const ins = db.prepare('INSERT INTO playlist_songs (playlist_id, position, track, artist) VALUES (?, ?, ?, ?)');
        tracks.forEach((t, pos) => {
          ins.run(id, pos, t.track, t.artist);
          if (t.spotifyId) this.saveSongLink(songKey(t.artist, t.track), t.spotifyId);
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    // Stored songs for a playlist, or null if none were saved. songsTotal is the track count they were fetched for.
    getPlaylistSongs(id) {
      const meta = db.prepare('SELECT songs_total, songs_synced_at FROM playlist_meta WHERE playlist_id = ?').get(id);
      if (!meta || meta.songs_synced_at === null) return null;
      const tracks = db.prepare('SELECT track, artist FROM playlist_songs WHERE playlist_id = ? ORDER BY position').all(id);
      return { tracks, songsTotal: meta.songs_total, syncedAt: meta.songs_synced_at };
    },
    // Latest play that has a score, with how the score was made (for the /mood embed).
    latestScoredPlay(userId) {
      return db.prepare(`SELECT p.track, p.artist, p.score, p.played_at, c.source
                         FROM plays p LEFT JOIN score_cache c ON c.track_id = p.track_id
                         WHERE p.user_id = ? AND p.score IS NOT NULL
                         ORDER BY p.id DESC LIMIT 1`).get(userId);
    },
    // Inserts an imported play unless one already exists for this user at the same time, or the same track within 5 minutes.
    importPlay({ userId, trackId, track, artist, score, playedAt }) {
      const r = db.prepare(`INSERT INTO plays (user_id, played_at, track_id, track, artist, score)
                            SELECT ?, ?, ?, ?, ?, ?
                            WHERE NOT EXISTS (
                              SELECT 1 FROM plays WHERE user_id = ? AND (played_at = ? OR
                                (track_id = ? AND abs(strftime('%s', played_at) - strftime('%s', ?)) < 300)))`)
        .run(userId, playedAt, trackId, track, artist, score, userId, playedAt, trackId, playedAt);
      return r.changes > 0;
    },
    // One page of a friend's plays, newest first.
    listPlays(userId, limit, offset) {
      return db.prepare(`SELECT track, artist, score, played_at FROM plays
                         WHERE user_id = ? ORDER BY played_at DESC LIMIT ? OFFSET ?`).all(userId, limit, offset);
    },
    countPlays(userId) {
      return db.prepare('SELECT COUNT(*) AS n FROM plays WHERE user_id = ?').get(userId).n;
    },
    // Scored plays since `sinceIso`: count, average, and the best and worst three by score.
    historyStats(userId, sinceIso) {
      const rows = db.prepare(`SELECT track, artist, score FROM plays
                               WHERE user_id = ? AND score IS NOT NULL AND played_at >= ?
                               ORDER BY score DESC, id DESC`).all(userId, sinceIso);
      const avg = rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : null;
      return { count: rows.length, avg, best: rows.slice(0, 3), worst: rows.slice(-3).reverse() };
    },
    // Discord webhook events (installs, entitlements, ...), kept as the full JSON body. Installs are APPLICATION_AUTHORIZED.
    logDiscordEvent({ type, applicationId, timestamp, payload }) {
      db.prepare(`INSERT INTO discord_events (received_at, event_type, application_id, event_timestamp, payload)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(new Date().toISOString(), type, applicationId ?? null, timestamp ?? null, JSON.stringify(payload));
    },
    listDiscordEvents(limit = 100) {
      return db.prepare('SELECT received_at, event_type, application_id, event_timestamp, payload FROM discord_events ORDER BY id DESC LIMIT ?')
        .all(limit);
    },
    // A friend is tracked once they've signed in with Discord.
    listUsers() {
      return db.prepare("SELECT user_id, account FROM connections WHERE provider = 'discord'").all();
    },
  };
}

module.exports = { openDb };
