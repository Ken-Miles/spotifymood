const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moodCommand, moodEmbed, findFriend, friendChoices } = require('../src/mood');

const friends = [
  { user_id: '756538344573239407', account: 'Ben Bowen' },
  { user_id: '111', account: 'Sam' },
];

test('/mood works in guilds and user installs', () => {
  assert.deepEqual(moodCommand.contexts, [0, 1, 2]);
  assert.deepEqual(moodCommand.integration_types, [0, 1]);
  const name = moodCommand.options[0];
  assert.equal(name.name, 'name');
  assert.equal(name.autocomplete, true);
});

test('findFriend matches an ID, an exact name, then a partial name', () => {
  assert.equal(findFriend(friends, '111').account, 'Sam');
  assert.equal(findFriend(friends, 'SAM').account, 'Sam');
  assert.equal(findFriend(friends, 'ben').account, 'Ben Bowen');
  assert.equal(findFriend(friends, 'nobody'), undefined);
});

test('friendChoices offers matching friends as user IDs', () => {
  assert.deepEqual(friendChoices(friends, 'be'), [{ name: 'Ben Bowen', value: '756538344573239407' }]);
});

test('moodEmbed shows the score, a 10-cell bar, and the source', () => {
  const embed = moodEmbed('Ben Bowen', {
    track: 'Song', artist: 'Artist', score: 8, played_at: '2026-11-12T20:00:00.000Z', source: 'llm',
  }).toJSON();
  assert.match(embed.description, /`Song` — `Artist`/);
  assert.equal(embed.author.name, "Ben Bowen's mood");
  assert.equal(embed.color, 0x57f287);
  assert.equal(embed.fields[1].value, '`████████░░`');
  assert.equal(embed.fields[2].value, 'Claude rating');
});

test('moodEmbed falls back when the source is unknown', () => {
  const embed = moodEmbed('Ben', {
    track: 'Song', artist: 'Artist', score: 3, played_at: '2026-11-12T20:00:00.000Z', source: null,
  }).toJSON();
  assert.equal(embed.fields[2].value, 'Unknown');
  assert.equal(embed.color, 0x3b82f6);
});
