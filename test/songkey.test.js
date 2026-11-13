const { test } = require('node:test');
const assert = require('node:assert/strict');
const { songKey } = require('../src/scoring');

test('the same song gets the same key whichever source reported it', () => {
  assert.equal(songKey('Creedence Clearwater Revival', 'Fortunate Son'), songKey('creedence  clearwater revival', ' Fortunate Son '));
  assert.notEqual(songKey('Creedence Clearwater Revival', 'Fortunate Son'), songKey('Creedence Clearwater Revival', 'Proud Mary'));
});
