const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pagerComponents, parseGotoPage, gotoModal } = require('../src/pager');

const ids = (rows) => rows.map((r) => r.toJSON().components.map((c) => c.custom_id ?? c.label)).flat();

test('more than 25 pages shows a Go to button instead of the page menu', () => {
  const rows = pagerComponents('moodlist:u', 0, 200);
  assert.equal(rows.length, 2);
  const second = rows[1].toJSON().components;
  assert.equal(second[0].type, 2); // a button, not a select menu
  assert.equal(second[0].custom_id, 'moodlist:u:goto');
});

test('25 pages or fewer keeps the page menu, and one page shows no second row', () => {
  assert.equal(pagerComponents('x', 0, 25)[1].toJSON().components[0].type, 3); // a string select
  assert.equal(pagerComponents('x', 0, 1).length, 1);
});

test('the Go to modal and its page parser accept only pages in range', () => {
  assert.equal(gotoModal('moodlist:u', 200).toJSON().custom_id, 'moodlist:u:modal:200');
  assert.equal(parseGotoPage('1', 200), 0);
  assert.equal(parseGotoPage(' 200 ', 200), 199);
  assert.equal(parseGotoPage('201', 200), null);
  assert.equal(parseGotoPage('0', 200), null);
  assert.equal(parseGotoPage('abc', 200), null);
  assert.equal(parseGotoPage('2.5', 200), null);
  assert.ok(ids(pagerComponents('x', 0, 200)).includes('x:stop'));
});

const { disabledRows } = require('../src/pager');
test('stop disables paging controls but keeps link buttons working', () => {
  const message = [
    new (require('discord.js').ActionRowBuilder)().addComponents(
      new (require('discord.js').ButtonBuilder)().setLabel('Open in Spotify').setStyle(5).setURL('https://open.spotify.com/playlist/x'),
    ).toJSON(),
    ...pagerComponents('x', 2, 200).map((r) => r.toJSON()),
  ];
  const out = disabledRows(message).map((r) => r.toJSON().components);
  assert.equal(out[0][0].disabled ? true : false, false); // link stays enabled
  assert.equal(out[0][0].url, 'https://open.spotify.com/playlist/x');
  for (const c of out[1]) assert.equal(c.disabled, true);
  assert.equal(out[2][0].disabled, true); // the Go to button is disabled too
});
