const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { parseBatchReply } = require('../src/scoring');
const { historyCommand, historyEmbed, periodSince } = require('../src/history');
const { openDb } = require('../src/db');

test('batch reply parser reads numbered lines and skips junk', () => {
  assert.deepEqual(parseBatchReply('1: 6\n2. 4.5\n3) 9\nnoise\n5: 12', 4), [6, 4.5, 9, null]);
});

test('/moodhistory offers the three periods', () => {
  const names = historyCommand.options[1].choices.map((c) => c.value);
  assert.deepEqual(names, ['7', '30', 'all']);
});

test('periodSince goes back the right number of days', () => {
  const now = new Date('2026-11-12T00:00:00Z');
  assert.equal(periodSince('7', now), '2026-11-05T00:00:00.000Z');
  assert.equal(periodSince('all', now), new Date(0).toISOString());
});

test('historyEmbed shows the average and says when there is nothing scored', () => {
  const empty = historyEmbed('Ben', '7', { count: 0, avg: null, best: [], worst: [] }).toJSON();
  assert.equal(empty.description, 'No scored songs in this period yet.');
  const rated = historyEmbed('Ben', '30', {
    count: 2, avg: 7.25, best: [{ track: 'A', artist: 'X', score: 8 }], worst: [{ track: 'B', artist: 'Y', score: 6.5 }],
  }).toJSON();
  assert.match(rated.description, /Overall \*\*7.3\/10\*\* \(upbeat\)/);
  assert.equal(rated.fields[0].name, 'Happiest');
});

test('imported plays are not duplicated and stats use scored plays only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mood-')), 'test.db');
  const db = openDb(file);
  const base = { userId: 'u1', trackId: 't1', track: 'Song', artist: 'Artist', score: 8 };
  assert.equal(db.importPlay({ ...base, playedAt: '2026-11-10T10:00:00.000Z' }), true);
  // Same track within five minutes is a duplicate (the live poll may already have logged it).
  assert.equal(db.importPlay({ ...base, playedAt: '2026-11-10T10:03:00.000Z' }), false);
  assert.equal(db.importPlay({ ...base, trackId: 't2', track: 'Other', score: null, playedAt: '2026-11-10T11:00:00.000Z' }), true);
  const stats = db.historyStats('u1', '2026-11-01T00:00:00.000Z');
  assert.equal(stats.count, 1);
  assert.equal(stats.avg, 8);
});
