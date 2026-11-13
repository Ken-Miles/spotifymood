// Discord bot: polls each signed-in friend's now-playing (Discord, Spotify, Last.fm in that order),
// scores each new song once, and posts it to #mood.
const path = require('node:path');
const { Client, GatewayIntentBits, ActivityType, MessageFlags } = require('discord.js');
const { openDb } = require('./db');
const { scoreTrack, moodEmoji, songKey, songText, spotifyTrackUrl } = require('./scoring');
const { makeSealer } = require('./crypto');
const { makeProviders, resolveNowPlaying } = require('./providers');
const { createWeb } = require('./web');
const { moodCommand, moodEmbed, findFriend, friendChoices } = require('./mood');
const { historyCommand, historyEmbed, importLastfm, periodSince } = require('./history');
const { listCommand, listPage, listPages } = require('./list');
const { targetPage, gotoModal, parseGotoPage, disabledRows } = require('./pager');
const {
  playlistCommand, playlistId, playlistChoices, ratePlaylist, playlistEmbed, syncUserPlaylists,
  playlistSummary, summaryComponents, linkComponents, breakdownView, breakdownPages,
} = require('./playlist');

const env = process.env;
const REQUIRED = [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_PUBLIC_KEY',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET',
  'LASTFM_API_KEY', 'LASTFM_SHARED_SECRET',
  'MOOD_CHANNEL_ID', 'PUBLIC_BASE_URL', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ALLOWED_DISCORD_IDS',
];
for (const key of REQUIRED) {
  if (!env[key]) throw new Error(`Missing ${key} in .env`);
}

// POLL_SECONDS in .env (default 15). Discord presence is free to read; each Spotify or Last.fm check is one API call.
const POLL_MS = Number(env.POLL_SECONDS || 15) * 1000;
const allowed = new Set(env.ALLOWED_DISCORD_IDS.split(',').map((s) => s.trim()).filter(Boolean));
// Only these accounts get polled and posted. Unset means everyone who can sign in.
const tracked = env.TRACKED_DISCORD_IDS
  ? new Set(env.TRACKED_DISCORD_IDS.split(',').map((s) => s.trim()).filter(Boolean))
  : allowed;
// Optional per-friend channels, e.g. MOOD_CHANNEL_BY_USER=userId:channelId,userId2:channelId2. Others use MOOD_CHANNEL_ID.
const moodChannel = new Map(
  (env.MOOD_CHANNEL_BY_USER || '').split(',').map((s) => s.trim().split(':')).filter((p) => p.length === 2 && p[0] && p[1]),
);
// Tracked accounts in this list get plays logged and scored, but nothing is posted to #mood.
const quiet = new Set((env.QUIET_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const db = openDb(env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'mood.db'));
const sealer = makeSealer(env.TOKEN_ENCRYPTION_KEY);
const auth = makeProviders(env);
const client = new Client({
  // MessageContent is privileged: it must also be on in the Developer Portal (Bot tab).
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
  ],
});

const lastTrack = new Map(); // userId -> last track ID we handled, so each song is posted once

// Discord's gateway keeps presence in the cache, so this is always current without an extra request.
async function discordNowPlaying(userId) {
  for (const guild of client.guilds.cache.values()) {
    const presence = guild.presences.cache.get(userId);
    const a = presence?.activities.find((x) => x.name === 'Spotify' && x.type === ActivityType.Listening);
    // syncId is the Spotify track ID; fall back to title + artist if Discord omits it.
    if (a) return { trackId: a.syncId || `${a.details}|${a.state}`, track: a.details, artist: a.state };
  }
  return null;
}

async function nowPlayingFor(userId) {
  const byProvider = Object.fromEntries(db.getConnections(userId).map((c) => [c.provider, c]));
  return resolveNowPlaying(Object.keys(byProvider), {
    discord: () => discordNowPlaying(userId),
    spotify: () => auth.spotifyNowPlaying(sealer.open(byProvider.spotify.secret)),
    lastfm: () => auth.lastfmNowPlaying(byProvider.lastfm.account),
  }, (provider, err) => console.error(`${provider} failed for ${userId}: ${err.message}`));
}

async function handleTrack(userId, who, np) {
  // Keyed by artist and title, not by source, so switching between Discord, Spotify and Last.fm doesn't log a song twice.
  const trackId = songKey(np.artist, np.track);
  const prev = lastTrack.has(userId) ? lastTrack.get(userId) : db.lastTrackId(userId);
  if (trackId === prev) return;
  lastTrack.set(userId, trackId);

  const { track, artist, source } = np;
  // Live Spotify and Discord reports carry the Spotify track ID, so the song can link to Spotify from now on.
  if (source !== 'lastfm' && spotifyTrackUrl(np.trackId)) db.saveSongLink(trackId, np.trackId);
  let cached = db.getCachedScore(trackId);
  if (!cached) {
    const scored = await scoreTrack({
      artist, track, lastfmKey: env.LASTFM_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY,
    });
    if (scored.score !== null) {
      db.cacheScore(trackId, scored.score, scored.source);
      cached = scored;
    }
  }
  const score = cached?.score ?? null;
  db.logPlay({ userId, trackId, track, artist, score });
  console.log(`${who} via ${source}: "${track}" by ${artist} -> ${score ?? 'no score'}`);

  // POST_TO_CHANNELS=false in .env turns off automatic posts. Commands still work.
  if (score === null || quiet.has(userId) || env.POST_TO_CHANNELS === 'false') return;
  const channel = await client.channels.fetch(moodChannel.get(userId) ?? env.MOOD_CHANNEL_ID);
  await channel.send(`🎵 **${who}**: ${songText(track, artist, db.getSongLink(trackId))}\nMood: **${score}/10** ${moodEmoji(score)}`);
}

let polling = false;
async function pollAll() {
  if (polling) return; // a slow tick shouldn't overlap the next one
  polling = true;
  try {
    for (const u of db.listUsers()) {
      if (!tracked.has(u.user_id)) continue;
      try {
        const np = await nowPlayingFor(u.user_id);
        if (np) await handleTrack(u.user_id, u.account, np);
      } catch (err) {
        console.error(`poll failed for ${u.user_id}:`, err);
      }
    }
  } finally {
    polling = false;
  }
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Global command: works in servers and DMs. Replaces the app's global command list.
  client.application.commands.set([moodCommand, historyCommand, listCommand, playlistCommand]);
  for (const id of allowed) client.users.fetch(id).catch((err) => console.error(`name lookup failed for ${id}:`, err.message));
  setInterval(pollAll, POLL_MS);
  pollAll();
});

// Owner text command: "@Ben Bowen Bot owneronly" (or just "owneronly" in a DM) re-syncs the slash commands.
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !env.OWNER_DISCORD_ID || msg.author.id !== env.OWNER_DISCORD_ID) return;
  if (msg.guild && !msg.mentions.has(client.user)) return;
  if (!/\bowneronly\b/i.test(msg.content)) return;
  try {
    const synced = await client.application.commands.set([moodCommand, historyCommand, listCommand, playlistCommand]);
    await msg.reply(`Synced ${synced.size} command(s): ${[...synced.values()].map((c) => `/${c.name}`).join(', ')}`);
  } catch (err) {
    console.error('owneronly sync failed:', err);
    await msg.reply(`Sync failed: ${err.message}`).catch(() => {});
  }
});

// The user's profile picture for embeds. Undefined if Discord can't be reached, so the embed still posts.
async function avatarOf(userId) {
  const u = await client.users.fetch(userId).catch(() => null);
  return u?.displayAvatarURL({ size: 128 });
}

// Everyone on the allowlist, named from Discord's cache (prefetched at startup), so people who haven't signed in still show up.
// Adds each top and bottom song's Spotify URL, when known, for the history embed.
function withSongLinks(stats) {
  const add = (r) => ({ ...r, url: db.getSongLink(songKey(r.artist, r.track)) });
  return { ...stats, best: stats.best.map(add), worst: stats.worst.map(add) };
}

function allowedPeople() {
  return [...allowed].map((id) => {
    const u = client.users.cache.get(id);
    return { user_id: id, account: u ? (u.globalName ?? u.username) : id };
  });
}

// /moodhistory: replies at once, then imports Last.fm history in the background and posts the rating to the channel.
// Imports can take over an hour, longer than Discord's 15-minute reply window, so the result is posted as a message.
const importing = new Set(); // friends with an import running
client.on('interactionCreate', async (i) => {
  if (i.commandName !== 'moodhistory') return;
  const people = allowedPeople();
  try {
    if (i.isAutocomplete()) return i.respond(friendChoices(people, i.options.getFocused()));
    if (!i.isChatInputCommand()) return;
    await i.deferReply();
    const friend = findFriend(people, i.options.getString('name', true));
    if (!friend) return i.editReply('No allowed person matches that name.');
    if (!tracked.has(friend.user_id)) return i.editReply(`${friend.account} isn't tracked by the bot.`);
    if (importing.has(friend.user_id)) return i.editReply(`Already working on ${friend.account}'s history. Wait for that post.`);
    const period = i.options.getString('period') ?? 'all';
    const since = periodSince(period);
    const lastfm = db.getConnections(friend.user_id).find((c) => c.provider === 'lastfm');
    const channel = i.channel ?? await i.user.createDM();
    importing.add(friend.user_id);
    await i.editReply(lastfm
      ? `Importing ${friend.account}'s Last.fm history. The rating will be posted here when it's done.`
      : `Rating ${friend.account}'s logged plays. The result will be posted here.`);
    (async () => {
      try {
        let note = 'Bot-logged plays only (no Last.fm connected).';
        if (lastfm) {
          const r = await importLastfm({
            db, auth, userId: friend.user_id, username: lastfm.account, sinceIso: since,
            lastfmKey: env.LASTFM_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY,
          });
          note = `Imported ${r.added} new plays from Last.fm (${r.songsScored} songs newly scored).`;
        }
        const embed = historyEmbed(friend.account, period, withSongLinks(db.historyStats(friend.user_id, since)), await avatarOf(friend.user_id))
          .setFooter({ text: note });
        await channel.send({ content: `<@${i.user.id}> your ${friend.account} rating is ready:`, embeds: [embed] });
      } catch (err) {
        console.error('/moodhistory failed:', err);
        await channel.send(`The history for ${friend.account} failed: ${err.message}`).catch(() => {});
      } finally {
        importing.delete(friend.user_id);
      }
    })();
  } catch (err) {
    console.error('/moodhistory failed:', err);
    await i.editReply('Something went wrong.').catch(() => {});
  }
});

// /moodplaylist: rates one playlist, either a pasted Spotify link or one of the requester's own playlists.
// Background sync of a user's playlists into the database. One sync per user at a time.
const syncing = new Set();
function startPlaylistSync(userId, linked) {
  if (syncing.has(userId)) return;
  syncing.add(userId);
  syncUserPlaylists({ db, auth, refresh: sealer.open(linked.secret), userId })
    .catch((err) => console.error(`playlist sync failed for ${userId}:`, err.message))
    .finally(() => syncing.delete(userId));
}
client.on('interactionCreate', async (i) => {
  if (i.commandName !== 'moodplaylist') return;
  // Anyone can sign in, but only the allowlist can rate playlists (each rating uses Last.fm and Anthropic calls).
  if (!allowed.has(i.user.id)) {
    if (i.isAutocomplete()) return i.respond([]);
    return i.reply({ content: "Playlist ratings are only for the bot's friends.", flags: MessageFlags.Ephemeral });
  }
  const linked = db.getConnections(i.user.id).find((c) => c.provider === 'spotify');
  try {
    if (i.isAutocomplete()) {
      if (!linked) return i.respond([]);
      // Answer from the database at once. Re-sync in the background if the list is missing or older than 10 minutes.
      const last = db.userPlaylistsSyncedAt(i.user.id);
      if (!last || Date.now() - Date.parse(last) > 10 * 60_000) startPlaylistSync(i.user.id, linked);
      const rows = db.listUserPlaylists(i.user.id).map((r) => ({ id: r.playlist_id, name: r.name }));
      return i.respond(playlistChoices(rows, i.options.getFocused()));
    }
    if (!i.isChatInputCommand()) return;
    await i.deferReply();
    const id = playlistId(i.options.getString('playlist', true));
    if (!id) return i.editReply('Pick one of your playlists, or paste a Spotify playlist link.');
    if (!linked) return i.editReply(`Link Spotify first at ${env.PUBLIC_BASE_URL} to rate playlists.`);
    const refresh = sealer.open(linked.secret);
    let meta;
    let tracks;
    try {
      meta = await auth.spotifyPlaylist(refresh, id);
      db.savePlaylistMeta(id, meta);
      // Use the saved songs when they match the playlist's current track count; otherwise fetch and save them.
      const stored = db.getPlaylistSongs(id);
      if (stored && stored.songsTotal === meta.total) {
        tracks = stored.tracks;
      } else {
        tracks = await auth.spotifyPlaylistTracks(refresh, id);
        db.savePlaylistSongs(id, tracks, meta.total);
      }
    } catch (err) {
      if (/HTTP 403/.test(err.message)) {
        return i.editReply(`I can't read that playlist. Relink your Spotify at ${env.PUBLIC_BASE_URL} to allow that.`);
      }
      if (/HTTP 404/.test(err.message)) return i.editReply("I can't find that playlist, or your Spotify can't see it.");
      throw err;
    }
    const rating = await ratePlaylist(tracks, {
      db, lastfmKey: env.LASTFM_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY,
    });
    const embed = playlistEmbed({
      who: i.user.globalName ?? i.user.username, avatarUrl: i.user.displayAvatarURL({ size: 128 }),
      playlist: meta, image: meta.image, rating, id,
    });
    return i.editReply({ embeds: [embed], components: summaryComponents(id) });
  } catch (err) {
    console.error('/moodplaylist failed:', err);
    await i.editReply('Something went wrong.').catch(() => {});
  }
});

// Playlist buttons and the breakdown's paging: Breakdown, Summary, and pages of songs with their ratings.
client.on('interactionCreate', async (i) => {
  if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return;
  const [prefix, id, token, pages] = i.customId.split(':');
  if (prefix !== 'plist' && prefix !== 'plistb') return;
  try {
    // "plist" is the summary's buttons: Breakdown opens a new message. "plistb" is the breakdown message itself.
    if (prefix === 'plist') {
      return i.reply(breakdownView({ db, id, page: 0 }));
    }
    if (i.isModalSubmit()) {
      const page = parseGotoPage(i.fields.getTextInputValue('page'), Number(pages));
      if (page === null) return i.reply({ content: `Enter a page from 1 to ${pages}.`, flags: MessageFlags.Ephemeral });
      const view = breakdownView({ db, id, page });
      return i.isFromMessage() ? i.update(view) : i.reply(view);
    }
    if (token === 'goto') return i.showModal(gotoModal(`plistb:${id}`, breakdownPages(db, id)));
    if (token === 'stop') return i.update({ components: disabledRows(i.message.components) });
    if (token === 'summary') {
      const meta = db.getPlaylistMeta(id);
      if (!meta) return i.reply({ content: 'That playlist is no longer saved.', flags: MessageFlags.Ephemeral });
      const embed = playlistEmbed({ playlist: meta, image: meta.image, rating: playlistSummary(db, id), id });
      return i.reply({ embeds: [embed], components: summaryComponents(id) });
    }
    return i.update(breakdownView({ db, id, page: targetPage(token, i.values ?? []) }));
  } catch (err) {
    console.error('playlist control failed:', err);
  }
});

// /moodlist and its paging buttons and jump menu: pages through a friend's stored songs.
client.on('interactionCreate', async (i) => {
  const isList = i.isChatInputCommand() && i.commandName === 'moodlist';
  const isControl = (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('moodlist:');
  if (!isList && !isControl && !(i.isAutocomplete() && i.commandName === 'moodlist')) return;
  try {
    if (i.isAutocomplete()) return i.respond(friendChoices(allowedPeople(), i.options.getFocused()));
    if (isControl) {
      const [, userId, token, pages] = i.customId.split(':');
      if (token === 'stop') return i.update({ components: disabledRows(i.message.components) });
      if (!tracked.has(userId)) return i.update({ content: "That person isn't tracked.", embeds: [], components: [] });
      const who = allowedPeople().find((p) => p.user_id === userId)?.account ?? userId;
      if (i.isModalSubmit()) {
        const page = parseGotoPage(i.fields.getTextInputValue('page'), Number(pages));
        if (page === null) return i.reply({ content: `Enter a page from 1 to ${pages}.`, flags: MessageFlags.Ephemeral });
        const view = listPage({ db, userId, who, avatarUrl: await avatarOf(userId), page });
        return i.isFromMessage() ? i.update(view) : i.reply(view);
      }
      if (token === 'goto') return i.showModal(gotoModal(`moodlist:${userId}`, listPages(db, userId)));
      const page = targetPage(token, i.values ?? []);
      return i.update(listPage({ db, userId, who, avatarUrl: await avatarOf(userId), page }));
    }
    const friend = findFriend(allowedPeople(), i.options.getString('name', true));
    if (!friend) return i.reply({ content: 'No allowed person matches that name.', flags: MessageFlags.Ephemeral });
    if (!tracked.has(friend.user_id)) {
      return i.reply({ content: `${friend.account} isn't tracked by the bot.`, flags: MessageFlags.Ephemeral });
    }
    return i.reply(listPage({ db, userId: friend.user_id, who: friend.account, avatarUrl: await avatarOf(friend.user_id), page: 0 }));
  } catch (err) {
    console.error('/moodlist failed:', err);
  }
});

// /mood looks up allowed people. Only tracked people have scored plays.
client.on('interactionCreate', async (i) => {
  if (i.commandName !== 'mood') return;
  const people = allowedPeople();
  try {
    if (i.isAutocomplete()) return i.respond(friendChoices(people, i.options.getFocused()));
    if (!i.isChatInputCommand()) return;
    const friend = findFriend(people, i.options.getString('name', true));
    if (!friend) {
      return i.reply({ content: 'No allowed person matches that name.', flags: MessageFlags.Ephemeral });
    }
    if (!tracked.has(friend.user_id)) {
      return i.reply({ content: `${friend.account} isn't tracked by the bot.`, flags: MessageFlags.Ephemeral });
    }
    const play = db.latestScoredPlay(friend.user_id);
    if (!play) {
      return i.reply({ content: `No scored songs for ${friend.account} yet.`, flags: MessageFlags.Ephemeral });
    }
    const withLink = { ...play, url: db.getSongLink(songKey(play.artist, play.track)) };
    return i.reply({ embeds: [moodEmbed(friend.account, withLink, await avatarOf(friend.user_id))] });
  } catch (err) {
    console.error('/mood failed:', err);
    if (!i.isAutocomplete() && !i.replied && !i.deferred) {
      await i.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(env.DISCORD_TOKEN);

const port = Number(env.PORT || 3000);
createWeb({ env, db, sealer, auth }).listen(port, () => {
  console.log(`Sign-in page: ${env.PUBLIC_BASE_URL} (listening on port ${port})`);
});
