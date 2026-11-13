const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../src/db');

test('playlist lists and songs are saved, replaced, and read back', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plstore-')), 'test.db'));
  db.saveUserPlaylists('u1', [{ id: 'p1', name: 'Sad', image: null, total: 2 }, { id: 'p2', name: 'Happy', total: 1 }], '2026-11-12T00:00:00Z');
  assert.deepEqual(db.listUserPlaylists('u1').map((r) => r.name), ['Happy', 'Sad']);
  db.saveUserPlaylists('u1', [{ id: 'p2', name: 'Happy', total: 1 }], '2026-11-12T01:00:00Z');
  assert.deepEqual(db.listUserPlaylists('u1').map((r) => r.name), ['Happy']);
  assert.equal(db.getPlaylistSongs('p2'), null);
  db.savePlaylistSongs('p2', [{ track: 'A', artist: 'X' }, { track: 'B', artist: 'Y' }], 1);
  const stored = db.getPlaylistSongs('p2');
  assert.deepEqual(stored.tracks.map((t) => t.track), ['A', 'B']);
  assert.equal(stored.songsTotal, 1);
});
