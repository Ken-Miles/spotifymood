const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreFromTags, moodEmoji } = require('../src/scoring');

test('no matched tags gives null so the LLM fallback runs', () => {
  assert.equal(scoreFromTags([]), null);
  assert.equal(scoreFromTags(['rock', 'indie']), null);
});

test('happy tags reach the top of the scale', () => {
  assert.equal(scoreFromTags(['happy']), 10);
});

test('sad tags reach the bottom of the scale', () => {
  assert.equal(scoreFromTags(['sad']), 1);
});

test('neutral tags give the midpoint', () => {
  assert.equal(scoreFromTags(['chill']), 5.5);
});

test('unmatched tags are ignored and matching is case-insensitive', () => {
  assert.equal(scoreFromTags(['Rock', 'HAPPY']), 10);
});

test('mixed tags average their points', () => {
  // (-1 + 2) / 2 = 0.5 -> 5.5 + 1.125 = 6.625 -> 6.6
  assert.equal(scoreFromTags(['melancholy', 'happy']), 6.6);
});

test('emoji follows the score', () => {
  assert.equal(moodEmoji(9), '😄');
  assert.equal(moodEmoji(1), '😢');
});
