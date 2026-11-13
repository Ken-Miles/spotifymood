const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeSealer, sign, checkSig } = require('../src/crypto');
const { makeProviders, resolveNowPlaying, lastfmSig } = require('../src/providers');
const { createWeb } = require('../src/web');
const { openDb } = require('../src/db');

const KEY = crypto.randomBytes(32).toString('base64');

test('sealed tokens open back to the original text', () => {
  const s = makeSealer(KEY);
  assert.equal(s.open(s.seal('spotify-refresh-123')), 'spotify-refresh-123');
});

test('a tampered sealed token is rejected', () => {
  const s = makeSealer(KEY);
  const [iv, tag, body] = s.seal('secret').split('.');
  const last = body.slice(-1);
  const bad = [iv, tag, body.slice(0, -1) + (last === 'A' ? 'B' : 'A')].join('.');
  assert.throws(() => s.open(bad));
});

test('encryption key must be 32 bytes', () => {
  assert.throws(() => makeSealer(Buffer.from('short').toString('base64')));
});

test('cookie signatures verify and reject changes', () => {
  const sig = sign('secret', '123');
  assert.equal(checkSig('secret', '123', sig), true);
  assert.equal(checkSig('secret', '124', sig), false);
  assert.equal(checkSig('secret', '123', undefined), false);
});

test('lastfm signature sorts params, skips format, appends the secret, then md5s', () => {
  const sig = lastfmSig({ method: 'auth.getSession', api_key: 'KEY', token: 'TOK', format: 'json' }, 'SECRET');
  const expected = crypto.createHash('md5').update('api_keyKEYmethodauth.getSessiontokenTOKSECRET').digest('hex');
  assert.equal(sig, expected);
});

const env = {
  PUBLIC_BASE_URL: 'https://mood.example.com',
  DISCORD_CLIENT_ID: '123', DISCORD_CLIENT_SECRET: 'x',
  SPOTIFY_CLIENT_ID: 's', SPOTIFY_CLIENT_SECRET: 'y',
  LASTFM_API_KEY: 'k', LASTFM_SHARED_SECRET: 'z',
};

test('discord login asks for the agreed scopes and uses the right redirect', () => {
  const auth = makeProviders(env);
  const u = new URL(auth.discordLogin('abc'));
  assert.equal(u.searchParams.get('scope'), 'email identify role_connections.write applications.commands.permissions.update applications.entitlements');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://mood.example.com/auth/discord/callback');
  assert.equal(u.searchParams.get('state'), 'abc');
});

test('spotify login requests the agreed scopes', () => {
  const u = new URL(makeProviders(env).spotifyLogin('abc'));
  assert.equal(u.searchParams.get('scope'), 'user-read-playback-state user-read-currently-playing user-read-playback-position user-top-read user-read-recently-played user-read-email playlist-read-private playlist-read-collaborative');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://mood.example.com/auth/spotify/callback');
});

test('now-playing uses the first connected source that reports a track', async () => {
  const fetchers = {
    discord: async () => null,
    spotify: async () => ({ trackId: 's1', track: 'T', artist: 'A' }),
    lastfm: async () => ({ trackId: 'l1', track: 'T2', artist: 'B' }),
  };
  const np = await resolveNowPlaying(['discord', 'spotify', 'lastfm'], fetchers, () => {});
  assert.equal(np.source, 'spotify');
});

test('a failing source falls through to the next one', async () => {
  const errors = [];
  const fetchers = {
    discord: async () => { throw new Error('gateway down'); },
    spotify: async () => null,
    lastfm: async () => ({ trackId: 'l1', track: 'T', artist: 'B' }),
  };
  const np = await resolveNowPlaying(['discord', 'spotify', 'lastfm'], fetchers, (p) => errors.push(p));
  assert.equal(np.source, 'lastfm');
  assert.deepEqual(errors, ['discord']);
});

test('sources the friend has not connected are never called', async () => {
  let called = false;
  const fetchers = {
    discord: async () => { called = true; return null; },
    lastfm: async () => ({ trackId: 'l1', track: 'T', artist: 'B' }),
  };
  const np = await resolveNowPlaying(['lastfm'], fetchers, () => {});
  assert.equal(np.source, 'lastfm');
  assert.equal(called, false);
});

// --- web routes, with stubbed OAuth so no network is needed ---

function startServer(allowed = new Set(['111'])) {
  const db = openDb(':memory:');
  const auth = {
    discordLogin: (state) => `https://discord.test/authorize?state=${state}`,
    discordExchange: async (code) => (code === 'good' ? { id: '111', name: 'Ben' } : { id: '999', name: 'x' }),
    spotifyLogin: (state) => `https://spotify.test/authorize?state=${state}`,
    spotifyExchange: async () => ({ name: 'Ben S', refresh: 'refresh-abc' }),
    lastfmLogin: (state) => `https://lastfm.test/auth?state=${state}`,
    lastfmSession: async () => 'ben_lastfm',
  };
  const server = createWeb({
    env: { PUBLIC_BASE_URL: 'http://localhost', SESSION_SECRET: 'test-secret' },
    db,
    sealer: makeSealer(KEY),
    auth,
    allowed,
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, db, base: `http://localhost:${server.address().port}` }));
  });
}

const noRedirect = { redirect: 'manual' };

test('signed-out home page offers Discord sign-in', async () => {
  const { server, base } = await startServer();
  try {
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /Sign in with Discord/);
  } finally {
    server.close();
  }
});

test('a callback with no matching state is rejected', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/auth/discord/callback?code=good&state=abc`, noRedirect);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('connecting Spotify needs a signed-in user', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/auth/spotify/login`, noRedirect);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  } finally {
    server.close();
  }
});

test('a Discord account not on the allowlist is refused', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/auth/discord/callback?code=bad&state=abc`, {
      ...noRedirect, headers: { cookie: 'oauth_state=abc' },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('an allowlisted Discord sign-in sets a signed cookie and saves the account', async () => {
  const { server, db, base } = await startServer();
  try {
    const res = await fetch(`${base}/auth/discord/callback?code=good&state=abc`, {
      ...noRedirect, headers: { cookie: 'oauth_state=abc' },
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.getSetCookie().join(';'), /uid=111\./);
    assert.equal(db.listUsers()[0].account, 'Ben');
  } finally {
    server.close();
  }
});
