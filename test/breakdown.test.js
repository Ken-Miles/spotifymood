const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../src/db');
const { songKey } = require('../src/scoring');
const { breakdownView, playlistSummary, summaryComponents, playlistUrl } = require('../src/playlist');
const { pageOptions } = require('../src/pager');

test('breakdown lists songs in playlist order with their ratings, and pages past 15', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'test.db'));
  db.savePlaylistMeta('p1', { name: 'Mix', image: null, total: 20 });
  const tracks = Array.from({ length: 20 }, (_, n) => ({ track: `Song ${n + 1}`, artist: 'Artist' }));
  db.savePlaylistSongs('p1', tracks, 20);
  db.cacheScore(songKey('Artist', 'Song 1'), 8, 'lastfm');
  const first = breakdownView({ db, id: 'p1', page: 0 }).embeds[0].toJSON();
  assert.match(first.description, /^1\. .*\*\*8\*\* `Song 1` — `Artist`/);
  assert.match(first.description, /2\. — `Song 2`/);
  assert.equal(first.footer.text, 'Songs in playlist order · Page 1 of 2');
  const last = breakdownView({ db, id: 'p1', page: 99 }).embeds[0].toJSON();
  assert.match(last.description, /^16\. — `Song 16`/);
  assert.equal(first.url, playlistUrl('p1'));
});

test('summary comes from saved scores, and components keep the link and breakdown buttons', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sum-')), 'test.db'));
  db.savePlaylistMeta('p2', { name: 'Two', image: null, total: 2 });
  db.savePlaylistSongs('p2', [{ track: 'A', artist: 'X' }, { track: 'B', artist: 'Y' }], 2);
  db.cacheScore(songKey('X', 'A'), 6, 'lastfm');
  const s = playlistSummary(db, 'p2');
  assert.equal(s.average, 6);
  assert.equal(s.rated, 1);
  assert.equal(s.unique, 2);
  assert.equal(summaryComponents('p2')[0].components.length, 2);
});

test('the jump menu offers the first and last page', () => {
  const o = pageOptions(50, 200);
  assert.equal(o[0].value, '0');
  assert.equal(o[o.length - 1].value, '199');
  assert.ok(o.some((x) => x.default));
});
