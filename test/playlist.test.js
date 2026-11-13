const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { playlistId, playlistChoices, ratePlaylist, playlistEmbed, playlistCommand } = require('../src/playlist');
const { openDb } = require('../src/db');
const { songKey } = require('../src/scoring');

const ID = '37i9dQZF1DXcBWIGoYBM5M';

test('playlistId reads a link, a URI, or a bare ID, and rejects anything else', () => {
  assert.equal(playlistId(`https://open.spotify.com/playlist/${ID}?si=abc`), ID);
  assert.equal(playlistId(`https://open.spotify.com/intl-de/playlist/${ID}`), ID);
  assert.equal(playlistId(`spotify:playlist:${ID}`), ID);
  assert.equal(playlistId(ID), ID);
  assert.equal(playlistId('Sad Songs'), null);
  assert.equal(playlistId('https://open.spotify.com/track/abc'), null);
});

test('playlistChoices only offers playlists whose names match, up to 25', () => {
  const lists = [{ id: 'a', name: 'Sad Songs' }, { id: 'b', name: 'Road Trip 2024' }];
  assert.deepEqual(playlistChoices(lists, 'trip'), [{ name: 'Road Trip 2024', value: 'b' }]);
  assert.equal(playlistChoices(lists, '').length, 2);
});

test('the command takes one playlist argument', () => {
  assert.equal(playlistCommand.options.length, 1);
  assert.equal(playlistCommand.options[0].name, 'playlist');
  assert.equal(playlistCommand.options[0].autocomplete, true);
});

test('ratePlaylist averages songs already in the cache without calling any API', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'test.db');
  const db = openDb(file);
  db.cacheScore(songKey('Artist A', 'Song 1'), 8, 'lastfm');
  db.cacheScore(songKey('Artist B', 'Song 2'), 4, 'llm');
  const tracks = [
    { track: 'Song 1', artist: 'Artist A' },
    { track: 'Song 2', artist: 'Artist B' },
    { track: 'Song 2', artist: 'Artist B' }, // repeat counts once
  ];
  const r = await ratePlaylist(tracks, { db, lastfmKey: '', anthropicKey: '' });
  assert.equal(r.unique, 2);
  assert.equal(r.rated, 2);
  assert.equal(r.average, 6);
});

test('playlistEmbed shows the average, or says nothing could be rated', () => {
  const rated = playlistEmbed({
    who: 'Ben', playlist: { name: 'Sad Songs', total: 10 }, rating: { average: 3.25, rated: 9, unique: 10 },
  }).toJSON();
  assert.equal(rated.title, 'Sad Songs');
  assert.match(rated.description, /Overall \*\*3.3\/10\*\*/);
  const none = playlistEmbed({
    who: 'Ben', playlist: { name: 'Sad Songs', total: 0 }, rating: { average: null, rated: 0, unique: 0 },
  }).toJSON();
  assert.equal(none.description, 'None of the songs in this playlist could be rated.');
});
