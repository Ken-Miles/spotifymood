// /moodplaylist: rates every song in one Spotify playlist, shows the average, and can break it down song by song.
const {
  SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
  InteractionContextType, ApplicationIntegrationType,
} = require('discord.js');
const { songKey, moodEmoji, songText } = require('./scoring');
const { scoreSongs } = require('./history');
const { pagerComponents } = require('./pager');

const PER_PAGE = 15; // songs per breakdown page

const playlistCommand = new SlashCommandBuilder()
  .setName('moodplaylist')
  .setDescription('Rate a Spotify playlist: pick one of yours, or paste a link')
  .addStringOption((o) => o.setName('playlist').setDescription('Your playlist, or a Spotify playlist link').setRequired(true).setAutocomplete(true))
  .setContexts([InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel])
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall])
  .toJSON();

// Accepts a Spotify playlist link, a spotify:playlist: URI, or a bare ID (what autocomplete sends).
function playlistId(input) {
  const s = input.trim();
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]{22})/)
    ?? s.match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{22}$/.test(s) ? s : null;
}

function playlistUrl(id) {
  return `https://open.spotify.com/playlist/${id}`;
}

// Autocomplete choices from the requester's own playlists. Discord allows 25.
function playlistChoices(playlists, input) {
  const q = String(input).trim().toLowerCase();
  return playlists
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((p) => ({ name: p.name.slice(0, 100), value: p.id }));
}

// Scores each unique song once (cached songs are not looked up again), and averages the rated ones.
// Returns { average, rated, unique } where average is null if nothing could be rated.
async function ratePlaylist(tracks, { db, lastfmKey, anthropicKey }) {
  const songs = [...new Map(tracks.map((t) => [songKey(t.artist, t.track), t])).entries()]
    .map(([trackId, t]) => ({ trackId, track: t.track, artist: t.artist }));
  const known = new Map();
  const cached = new Map();
  for (const s of songs) {
    const c = db.getCachedScore(s.trackId);
    if (c) { cached.set(s.trackId, true); known.set(s.trackId, c.score); }
  }
  const scored = await scoreSongs(songs, { cached, lastfmKey, anthropicKey });
  for (const [trackId, r] of scored) {
    db.cacheScore(trackId, r.score, r.source);
    known.set(trackId, r.score);
  }
  const scores = [...known.values()];
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return { average, rated: scores.length, unique: songs.length };
}

// The same summary as ratePlaylist, but from saved songs and scores only (no API calls).
function playlistSummary(db, id) {
  const songs = db.getPlaylistSongs(id)?.tracks ?? [];
  const seen = new Map();
  for (const s of songs) {
    const k = songKey(s.artist, s.track);
    if (!seen.has(k)) seen.set(k, db.getCachedScore(k)?.score ?? null);
  }
  const scores = [...seen.values()].filter((v) => v !== null);
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return { average, rated: scores.length, unique: seen.size };
}

function scoreColor(avg) {
  if (avg >= 7) return 0x57f287;
  if (avg >= 4) return 0xfee75c;
  return 0x3b82f6;
}

// Summary embed. The title links to the playlist. `who` and `avatarUrl` are optional.
function playlistEmbed({ who, avatarUrl, playlist, image, rating, id }) {
  const embed = new EmbedBuilder().setTitle(playlist.name.slice(0, 256)).setURL(playlistUrl(id));
  if (who) embed.setAuthor({ name: `${who} rated`, iconURL: avatarUrl });
  if (image) embed.setThumbnail(image);
  if (rating.average === null) {
    return embed.setDescription('None of the songs in this playlist could be rated.');
  }
  const avg = Math.round(rating.average * 10) / 10;
  return embed
    .setColor(scoreColor(avg))
    .setDescription(`${moodEmoji(avg)} Overall **${avg}/10**`)
    .addFields(
      { name: 'Songs rated', value: `${rating.rated} of ${rating.unique} unique songs`, inline: true },
      { name: 'Playlist size', value: `${playlist.total} tracks`, inline: true },
    );
}

function openButton(id) {
  return new ButtonBuilder().setLabel('Open in Spotify').setStyle(ButtonStyle.Link).setURL(playlistUrl(id));
}

// Buttons under the summary: open the playlist, or open the song-by-song breakdown as a new message.
function summaryComponents(id) {
  return [new ActionRowBuilder().addComponents(
    openButton(id),
    new ButtonBuilder().setCustomId(`plist:${id}:breakdown`).setLabel('Breakdown').setStyle(ButtonStyle.Primary),
  )];
}

// Just the link, kept when the breakdown is stopped.
function linkComponents(id) {
  return [new ActionRowBuilder().addComponents(openButton(id))];
}

// One page of the breakdown: songs in playlist order, each with its rating (or a dash if it has none).
function breakdownView({ db, id, page }) {
  const meta = db.getPlaylistMeta(id);
  const songs = db.getPlaylistSongs(id)?.tracks ?? [];
  const pages = Math.max(1, Math.ceil(songs.length / PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const start = current * PER_PAGE;
  const lines = songs.slice(start, start + PER_PAGE).map((s, j) => {
    const score = db.getCachedScore(songKey(s.artist, s.track))?.score;
    const mood = score === undefined ? '—' : `${moodEmoji(score)} **${score}**`;
    return `${start + j + 1}. ${mood} ${songText(s.track, s.artist, db.getSongLink(songKey(s.artist, s.track)))}`;
  });
  const embed = new EmbedBuilder()
    .setTitle((meta?.name ?? 'Playlist').slice(0, 256))
    .setURL(playlistUrl(id))
    .setDescription(lines.join('\n') || 'No songs saved for this playlist yet.')
    .setFooter({ text: `Songs in playlist order · Page ${current + 1} of ${pages}` });
  if (meta?.image) embed.setThumbnail(meta.image);
  const top = new ActionRowBuilder().addComponents(
    openButton(id),
    new ButtonBuilder().setCustomId(`plistb:${id}:summary`).setLabel('Summary').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [top, ...pagerComponents(`plistb:${id}`, current, pages)] };
}

// Background sync of one user's playlists and songs. Saves a playlist list, then songs for any playlist that's new or changed.
async function syncUserPlaylists({ db, auth, refresh, userId }) {
  const lists = await auth.spotifyPlaylists(refresh);
  db.saveUserPlaylists(userId, lists, new Date().toISOString());
  for (const p of lists) {
    const stored = db.getPlaylistSongs(p.id);
    if (stored && stored.songsTotal === p.total) continue;
    try {
      db.savePlaylistSongs(p.id, await auth.spotifyPlaylistTracks(refresh, p.id), p.total);
    } catch (err) {
      console.error(`playlist sync skipped ${p.name}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // stay under Spotify's rate limit
  }
  return lists.length;
}

// Number of breakdown pages for a playlist.
function breakdownPages(db, id) {
  return Math.max(1, Math.ceil((db.getPlaylistSongs(id)?.tracks.length ?? 0) / PER_PAGE));
}

module.exports = {
  breakdownPages, playlistCommand, playlistId, playlistChoices, ratePlaylist, playlistEmbed, syncUserPlaylists,
  playlistSummary, summaryComponents, linkComponents, breakdownView, playlistUrl,
};
