// /moodlist: pages through a friend's stored songs, newest first.
const {
  SlashCommandBuilder, EmbedBuilder, InteractionContextType, ApplicationIntegrationType,
} = require('discord.js');
const { moodEmoji, songKey, songText } = require('./scoring');
const { pagerComponents } = require('./pager');

const PAGE = 10;

const listCommand = new SlashCommandBuilder()
  .setName('moodlist')
  .setDescription("List a friend's stored songs, newest first")
  .addStringOption((o) => o.setName('name').setDescription('Friend to check').setRequired(true).setAutocomplete(true))
  .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
  .toJSON();

// Builds one page: { embeds, components }. Buttons carry the user ID and page, so they need no stored state.
function listPage({ db, userId, who, avatarUrl, page }) {
  const total = db.countPlays(userId);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const rows = db.listPlays(userId, PAGE, current * PAGE);
  const lines = rows.map((r) => {
    const mood = r.score === null ? '—' : `${moodEmoji(r.score)} **${r.score}**`;
    const when = Math.floor(Date.parse(r.played_at) / 1000);
    return `${mood} ${songText(r.track, r.artist, db.getSongLink(songKey(r.artist, r.track)))} · <t:${when}:d>`;
  });
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${who}'s songs`, iconURL: avatarUrl })
    .setDescription(lines.join('\n') || 'No songs stored yet.')
    .setFooter({ text: `Page ${current + 1} of ${pages} · ${total} plays · Spotify keeps only recent plays` });
  return { embeds: [embed], components: pagerComponents(`moodlist:${userId}`, current, pages) };
}

// Number of pages in a friend's list.
function listPages(db, userId) {
  return Math.max(1, Math.ceil(db.countPlays(userId) / PAGE));
}

module.exports = { listCommand, listPage, listPages };
