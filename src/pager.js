// Shared paging controls: First, Previous, a red Stop, Next, Last, then a page menu (up to 25 pages) or a "Go to..." button (more than 25).
// Button IDs look like `${prefix}:<page>`, `${prefix}:first|last|stop|goto`, the menu is `${prefix}:select`,
// and the modal is `${prefix}:modal:<pages>`.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const MENU_LIMIT = 25; // Discord allows 25 options in a menu

// Pages offered by the jump menu: the first and last page, and a window around the current one.
function pageOptions(current, pages) {
  const set = new Set([0, pages - 1]);
  for (let p = Math.max(0, current - 10); p <= Math.min(pages - 1, current + 10); p++) set.add(p);
  return [...set].sort((a, b) => a - b).slice(0, MENU_LIMIT).map((p) => ({
    label: `Page ${p + 1} of ${pages}`, value: String(p), default: p === current,
  }));
}

function pagerComponents(prefix, page, pages) {
  const button = (token, label, style, disabled) => new ButtonBuilder()
    .setCustomId(`${prefix}:${token}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const rows = [new ActionRowBuilder().addComponents(
    // Every button needs a unique ID. First is "first", not "0", which Previous would also use on page 2.
    button('first', 'First', ButtonStyle.Secondary, page <= 0),
    button(String(page - 1), 'Previous', ButtonStyle.Secondary, page <= 0),
    button('stop', 'Stop', ButtonStyle.Danger, false),
    button(String(page + 1), 'Next', ButtonStyle.Secondary, page >= pages - 1),
    button('last', 'Last', ButtonStyle.Secondary, page >= pages - 1),
  )];
  if (pages > MENU_LIMIT) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}:goto`).setLabel('Go to...').setStyle(ButtonStyle.Primary),
    ));
  } else if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${prefix}:select`).setPlaceholder('Jump to a page')
        .addOptions(pageOptions(page, pages)),
    ));
  }
  return rows;
}

// The "Go to..." modal: asks for a page number from 1 to `pages`.
function gotoModal(prefix, pages) {
  return new ModalBuilder()
    .setCustomId(`${prefix}:modal:${pages}`)
    .setTitle('Go to page')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('page')
        .setLabel(`Page number (1 to ${pages})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(String(pages).length),
    ));
}

// Turns the modal's text into a zero-based page, or null if it isn't a page in range.
function parseGotoPage(text, pages) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < 1 || n > pages) return null;
  return n - 1;
}

// Turns a button or menu token into a page number. "last" means the final page (clamped by the caller).
function targetPage(token, values) {
  if (token === 'select') return Number(values[0]);
  if (token === 'first') return 0;
  if (token === 'last') return Infinity;
  return Number(token);
}

// Stop: greys out every control on the message, but leaves link buttons (such as Open in Spotify) working.
function disabledRows(rows) {
  return rows.map((row) => new ActionRowBuilder().addComponents(
    row.components.map((c) => {
      if (c.type === ComponentType.Button && c.style === ButtonStyle.Link) return ButtonBuilder.from(c);
      if (c.type === ComponentType.Button) return ButtonBuilder.from(c).setDisabled(true);
      return StringSelectMenuBuilder.from(c).setDisabled(true);
    }),
  ));
}

module.exports = { pagerComponents, pageOptions, targetPage, gotoModal, parseGotoPage, disabledRows, MENU_LIMIT };
