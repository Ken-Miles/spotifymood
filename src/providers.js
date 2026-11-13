// OAuth sign-in and now-playing lookups for Discord, Spotify and Last.fm.
const crypto = require('node:crypto');

const DISCORD_API = 'https://discord.com/api';
const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const SPOTIFY_SCOPES = [
  'user-read-playback-state', 'user-read-currently-playing', // Spotify Connect
  'user-read-playback-position', 'user-top-read', 'user-read-recently-played', // listening history
  'user-read-email', // users
  'playlist-read-private', 'playlist-read-collaborative', // playlists, including private and shared ones
].join(' ');

// Most reliable first: Discord pushes presence in real time, Spotify is near-live, Last.fm lags on scrobbles.
const PRIORITY = ['discord', 'spotify', 'lastfm'];

// Last.fm signature: sort params (skipping format and callback), append the shared secret, md5.
function lastfmSig(params, secret) {
  const s = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('') + secret;
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

async function json(res, what) {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return res.json();
}

// Picks the first connected source (in PRIORITY order) that reports something playing.
// A source that throws is reported and skipped, so the next one can take over.
async function resolveNowPlaying(connected, fetchers, onError) {
  for (const provider of PRIORITY) {
    if (!connected.includes(provider)) continue;
    try {
      const np = await fetchers[provider]();
      if (np) return { ...np, source: provider };
    } catch (err) {
      onError(provider, err);
    }
  }
  return null;
}

function makeProviders(env) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const redirect = (provider) => `${base}/auth/${provider}/callback`;
  const spotifyBasic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

  async function spotifyToken(fields) {
    return json(await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${spotifyBasic}` },
      body: new URLSearchParams(fields),
    }), 'spotify token');
  }

  // Access tokens last an hour; keep them in memory so each poll doesn't refresh.
  const spotifyAccessCache = new Map();
  async function spotifyAccess(refresh) {
    const hit = spotifyAccessCache.get(refresh);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const tok = await spotifyToken({ grant_type: 'refresh_token', refresh_token: refresh });
    spotifyAccessCache.set(refresh, { token: tok.access_token, exp: Date.now() + tok.expires_in * 1000 });
    return tok.access_token;
  }

  return {
    // Discord: sign-in identifies the friend. Presence itself comes from the bot's gateway connection.
    discordLogin(state) {
      return `${DISCORD_API}/oauth2/authorize?${new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirect('discord'),
        response_type: 'code', state,
        // applications.commands.update is left out: Discord rejects it on this app's sign-in URL (400 {"scope": ["3"]}).
        scope: 'email identify role_connections.write applications.commands.permissions.update applications.entitlements',
      })}`;
    },
    async discordExchange(code) {
      const tok = await json(await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code, redirect_uri: redirect('discord'),
        }),
      }), 'discord token');
      const me = await json(await fetch(`${DISCORD_API}/users/@me`, {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }), 'discord user');
      return { id: me.id, name: me.global_name || me.username };
    },

    spotifyLogin(state) {
      return `${SPOTIFY_ACCOUNTS}/authorize?${new URLSearchParams({
        client_id: env.SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: redirect('spotify'),
        scope: SPOTIFY_SCOPES, state,
      })}`;
    },
    async spotifyExchange(code) {
      const tok = await spotifyToken({ grant_type: 'authorization_code', code, redirect_uri: redirect('spotify') });
      const me = await json(await fetch(`${SPOTIFY_API}/me`, {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }), 'spotify user');
      return { name: me.display_name || me.id, refresh: tok.refresh_token };
    },
    // All of the user's playlists. A connection made before the playlist scopes existed gets HTTP 403.
    async spotifyPlaylists(refresh) {
      const headers = { authorization: `Bearer ${await spotifyAccess(refresh)}` };
      const out = [];
      let url = `${SPOTIFY_API}/me/playlists?limit=50`;
      while (url) {
        const data = await json(await fetch(url, { headers }), 'spotify playlists');
        for (const p of data.items) {
          out.push({ id: p.id, name: p.name, image: p.images?.[0]?.url, total: p.tracks?.total ?? p.items?.total ?? 0 });
        }
        url = data.next;
      }
      return out;
    },
    // One playlist's name, cover and track count, by ID.
    async spotifyPlaylist(refresh, playlistId) {
      const headers = { authorization: `Bearer ${await spotifyAccess(refresh)}` };
      const data = await json(await fetch(`${SPOTIFY_API}/playlists/${playlistId}`, { headers }), 'spotify playlist');
      return { id: data.id, name: data.name, image: data.images?.[0]?.url, total: data.tracks?.total ?? data.items?.total ?? 0 };
    },
    // Tracks in a playlist, with Spotify's newer /items path and the older /tracks path as a fallback.
    async spotifyPlaylistTracks(refresh, playlistId) {
      const headers = { authorization: `Bearer ${await spotifyAccess(refresh)}` };
      let res = await fetch(`${SPOTIFY_API}/playlists/${playlistId}/items?limit=50`, { headers });
      if (res.status === 404) res = await fetch(`${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=50`, { headers });
      const out = [];
      let data = await json(res, 'spotify playlist tracks');
      for (;;) {
        for (const entry of data.items) {
          const t = entry.item ?? entry.track;
          if (t?.type !== 'track' || !t.name) continue; // skips podcast episodes and removed tracks
          out.push({ track: t.name, artist: t.artists.map((a) => a.name).join(', '), spotifyId: t.id });
        }
        if (!data.next) return out;
        data = await json(await fetch(data.next, { headers }), 'spotify playlist tracks');
      }
    },
    // 204 means nothing is playing.
    async spotifyNowPlaying(refresh) {
      const res = await fetch(`${SPOTIFY_API}/me/player/currently-playing`, {
        headers: { authorization: `Bearer ${await spotifyAccess(refresh)}` },
      });
      if (res.status === 204) return null;
      const data = await json(res, 'spotify now playing');
      if (!data.is_playing || data.item?.type !== 'track') return null;
      return {
        trackId: data.item.id,
        track: data.item.name,
        artist: data.item.artists.map((a) => a.name).join(', '),
      };
    },

    lastfmLogin(state) {
      const cb = `${redirect('lastfm')}?state=${encodeURIComponent(state)}`;
      return `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: env.LASTFM_API_KEY, cb })}`;
    },
    // Called with the token Last.fm sends back. Returns the Last.fm username.
    async lastfmSession(token) {
      const params = { method: 'auth.getSession', api_key: env.LASTFM_API_KEY, token };
      const data = await json(await fetch(LASTFM_API, {
        method: 'POST',
        body: new URLSearchParams({ ...params, api_sig: lastfmSig(params, env.LASTFM_SHARED_SECRET), format: 'json' }),
      }), 'lastfm session');
      if (!data.session) throw new Error(`lastfm session failed: ${data.message || 'no session'}`);
      return data.session.name;
    },
    // Scrobbles since `from` (unix seconds), oldest pages first. Skips the "now playing" entry.
    async lastfmHistory(username, from) {
      const plays = [];
      for (let page = 1; ; page++) {
        const p = new URLSearchParams({
          method: 'user.getrecenttracks', user: username, limit: '200', page: String(page),
          from: String(from), api_key: env.LASTFM_API_KEY, format: 'json',
        });
        const data = await json(await fetch(`${LASTFM_API}?${p}`), 'lastfm history');
        const rt = data.recenttracks;
        for (const t of [].concat(rt?.track ?? [])) {
          if (!t.date) continue; // now playing has no date
          const artist = t.artist['#text'];
          plays.push({
            trackId: `lastfm|${artist}|${t.name}`, track: t.name, artist,
            playedAt: new Date(Number(t.date.uts) * 1000).toISOString(),
          });
        }
        if (page >= Number(rt?.['@attr']?.totalPages ?? 1)) return plays;
        await new Promise((r) => setTimeout(r, 250)); // stay well under Last.fm's rate limit
      }
    },
    async lastfmNowPlaying(username) {
      const p = new URLSearchParams({
        method: 'user.getrecenttracks', user: username, limit: '1', api_key: env.LASTFM_API_KEY, format: 'json',
      });
      const data = await json(await fetch(`${LASTFM_API}?${p}`), 'lastfm recent tracks');
      const t = [].concat(data.recenttracks?.track ?? [])[0];
      if (!t || t['@attr']?.nowplaying !== 'true') return null;
      const artist = t.artist['#text'];
      return { trackId: `lastfm|${artist}|${t.name}`, track: t.name, artist };
    },
  };
}

module.exports = { makeProviders, resolveNowPlaying, lastfmSig, PRIORITY };
