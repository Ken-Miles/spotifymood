// /moodhistory: imports a friend's Last.fm scrobbles, then rates their listening over a period.
const { SlashCommandBuilder, EmbedBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { scoreFromTags, fetchTopTags, llmScoreBatch, moodEmoji, songKey, songText } = require('./scoring');

const BATCH = 20; // songs per Claude call

const historyCommand = new SlashCommandBuilder()
  .setName('moodhistory')
  .setDescription("Rate a friend's listening over a period")
  .addStringOption((o) => o.setName('name').setDescription('Friend to check').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('period').setDescription('How far back to look').addChoices(
    { name: 'Last 7 days', value: '7' },
    { name: 'Last 30 days', value: '30' },
    { name: 'All time', value: 'all' },
  ))
  .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
  .toJSON();

// Start of the period as an ISO time. "all" starts at the Last.fm epoch.
function periodSince(period, now = new Date()) {
  if (period === 'all' || !period) return new Date(0).toISOString();
  return new Date(now.getTime() - Number(period) * 24 * 60 * 60 * 1000).toISOString();
}

function periodLabel(period) {
  return period === '7' ? 'last 7 days' : period === '30' ? 'last 30 days' : 'all time';
}

function vibe(avg) {
  if (avg >= 7) return 'upbeat';
  if (avg >= 4) return 'mixed';
  return 'down';
}

// Scores songs that have a Last.fm trackId, using tags first and one batched Claude call per chunk for the rest.
// `cached` maps trackId -> score (or null) already known; newly scored songs are returned in `scored`.
async function scoreSongs(songs, { cached, lastfmKey, anthropicKey }) {
  const scored = new Map();
  const pending = [];
  for (const s of songs) {
    if (cached.has(s.trackId)) continue;
    const tags = await fetchTopTags(s.artist, s.track, lastfmKey);
    await new Promise((r) => setTimeout(r, 200)); // stay under Last.fm's rate limit
    const fromTags = scoreFromTags(tags);
    if (fromTags !== null) scored.set(s.trackId, { score: fromTags, source: 'lastfm' });
    else pending.push(s);
  }
  if (anthropicKey) {
    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      const scores = await llmScoreBatch(chunk, anthropicKey);
      chunk.forEach((s, j) => {
        if (scores[j] !== null) scored.set(s.trackId, { score: scores[j], source: 'llm' });
      });
    }
  }
  return scored;
}

// Imports Last.fm scrobbles since `sinceIso` into plays, scoring each unique track once.
async function importLastfm({ db, auth, userId, username, sinceIso, lastfmKey, anthropicKey }) {
  const plays = (await auth.lastfmHistory(username, Math.floor(new Date(sinceIso).getTime() / 1000)))
    .map((p) => ({ ...p, trackId: songKey(p.artist, p.track) }));
  const unique = [...new Map(plays.map((p) => [p.trackId, p])).values()];
  const cached = new Map(unique.filter((s) => db.getCachedScore(s.trackId)).map((s) => [s.trackId, true]));
  const scored = await scoreSongs(unique, { cached, lastfmKey, anthropicKey });
  for (const [trackId, r] of scored) db.cacheScore(trackId, r.score, r.source);

  let added = 0;
  for (const p of plays) {
    const score = db.getCachedScore(p.trackId)?.score ?? null;
    if (db.importPlay({ userId, trackId: p.trackId, track: p.track, artist: p.artist, score, playedAt: p.playedAt })) added++;
  }
  return { fetched: plays.length, added, songsScored: scored.size };
}

// Embed for a friend's rated period. stats: { count, avg, best, worst } from db.historyStats.
function historyEmbed(who, period, stats, avatarUrl) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${who}'s listening`, iconURL: avatarUrl })
    .setTitle(`Rating for the ${periodLabel(period)}`);
  if (stats.count === 0) {
    return embed.setDescription('No scored songs in this period yet.');
  }
  const line = (r) => `${moodEmoji(r.score)} **${r.score}** ${songText(r.track, r.artist, r.url)}`;
  const avg = Math.round(stats.avg * 10) / 10;
  return embed
    .setColor(avg >= 7 ? 0x57f287 : avg >= 4 ? 0xfee75c : 0x3b82f6)
    .setDescription(`Overall **${avg}/10** (${vibe(avg)}) from ${stats.count} scored plays`)
    .addFields(
      { name: 'Happiest', value: stats.best.map(line).join('\n').slice(0, 1024) },
      { name: 'Saddest', value: stats.worst.map(line).join('\n').slice(0, 1024) },
    );
}

module.exports = { historyCommand, historyEmbed, importLastfm, periodSince, periodLabel, vibe, scoreSongs };
