// /mood command: shows a tracked friend's latest scored song as an embed.
// Works in servers (guild install) and in DMs or the bot's private channel (user install).
const {
  SlashCommandBuilder, EmbedBuilder, InteractionContextType, ApplicationIntegrationType,
} = require('discord.js');
const { moodEmoji, songText } = require('./scoring');

const moodCommand = new SlashCommandBuilder()
  .setName('mood')
  .setDescription("Show a friend's latest mood score")
  .addStringOption((o) => o.setName('name').setDescription('Friend to check').setRequired(true).setAutocomplete(true))
  .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
  .toJSON();

const SOURCE_LABEL = { lastfm: 'Last.fm tags', llm: 'Claude rating' };

// Autocomplete picks come back as a user ID. Typed text matches exactly first, then as a part of the name.
function findFriend(friends, input) {
  const q = input.trim().toLowerCase();
  return friends.find((f) => f.user_id === input)
    ?? friends.find((f) => f.account.toLowerCase() === q)
    ?? friends.find((f) => f.account.toLowerCase().includes(q));
}

// Discord allows at most 25 autocomplete choices.
function friendChoices(friends, input) {
  const q = input.trim().toLowerCase();
  return friends
    .filter((f) => f.account.toLowerCase().includes(q))
    .slice(0, 25)
    .map((f) => ({ name: f.account, value: f.user_id }));
}

function moodColor(score) {
  if (score >= 7) return 0x57f287; // green
  if (score >= 4) return 0xfee75c; // yellow
  return 0x3b82f6; // blue
}

// Ten-cell bar for the 1-10 score, e.g. 8 -> ████████░░
function scoreBar(score) {
  const filled = Math.round(score);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// play: { track, artist, score, played_at, source } from db.latestScoredPlay
function moodEmbed(who, play, avatarUrl) {
  return new EmbedBuilder()
    .setColor(moodColor(play.score))
    .setAuthor({ name: `${who}'s mood`, iconURL: avatarUrl })
    .setDescription(songText(play.track, play.artist, play.url).slice(0, 4096))
    .addFields(
      { name: 'Mood', value: `${moodEmoji(play.score)} **${play.score}/10**`, inline: true },
      { name: 'Scale', value: `\`${scoreBar(play.score)}\``, inline: true },
      { name: 'Scored with', value: SOURCE_LABEL[play.source] ?? 'Unknown', inline: true },
    )
    .setFooter({ text: 'Last scored play' })
    .setTimestamp(new Date(play.played_at));
}

module.exports = { moodCommand, moodEmbed, findFriend, friendChoices };
