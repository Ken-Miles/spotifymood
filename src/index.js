// Discord bot: polls each signed-in friend's now-playing (Discord, Spotify, Last.fm in that order),
// scores each new song once, and posts it to #mood.
const path = require('node:path');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { openDb } = require('./db');
const { scoreTrack, moodEmoji } = require('./scoring');
const { makeSealer } = require('./crypto');
const { makeProviders, resolveNowPlaying } = require('./providers');
const { createWeb } = require('./web');

const env = process.env;
const REQUIRED = [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET',
  'LASTFM_API_KEY', 'LASTFM_SHARED_SECRET',
  'MOOD_CHANNEL_ID', 'PUBLIC_BASE_URL', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'ALLOWED_DISCORD_IDS',
];
for (const key of REQUIRED) {
  if (!env[key]) throw new Error(`Missing ${key} in .env`);
}

const POLL_MS = 15_000;
const allowed = new Set(env.ALLOWED_DISCORD_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const db = openDb(env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'mood.db'));
const sealer = makeSealer(env.TOKEN_ENCRYPTION_KEY);
const auth = makeProviders(env);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences],
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
  const prev = lastTrack.has(userId) ? lastTrack.get(userId) : db.lastTrackId(userId);
  if (np.trackId === prev) return;
  lastTrack.set(userId, np.trackId);

  const { trackId, track, artist, source } = np;
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

  if (score === null) return;
  const channel = await client.channels.fetch(env.MOOD_CHANNEL_ID);
  await channel.send(`🎵 **${who}**: **${track}** — ${artist}\nMood: **${score}/10** ${moodEmoji(score)}`);
}

let polling = false;
async function pollAll() {
  if (polling) return; // a slow tick shouldn't overlap the next one
  polling = true;
  try {
    for (const u of db.listUsers()) {
      if (!allowed.has(u.user_id)) continue;
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
  setInterval(pollAll, POLL_MS);
  pollAll();
});

client.login(env.DISCORD_TOKEN);

const port = Number(env.PORT || 3000);
createWeb({ env, db, sealer, auth, allowed }).listen(port, () => {
  console.log(`Sign-in page: ${env.PUBLIC_BASE_URL} (listening on port ${port})`);
});
