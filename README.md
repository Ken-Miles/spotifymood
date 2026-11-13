# BenBowenAutomation: Spotify Mood Bot

A Discord bot that scores a friend's listening from 1 to 10 and posts each new song to a `#mood` channel. Every play is logged to SQLite.

Your friend signs in once at a web page with Discord, then connects Spotify and/or Last.fm. The bot checks what they're playing and uses the most reliable connected source that's playing:

1. **Discord**: presence from the bot's live gateway connection (needs a shared server with the bot, and Spotify connected in Discord with activity shown)
2. **Spotify**: their currently playing track, polled every 15 seconds
3. **Last.fm**: their latest scrobble marked "now playing" (depends on their scrobbler)

## How scoring works

1. Looks up the song's Last.fm tags (`track.getTopTags`) and maps mood tags to a score: `5.5 + 2.25 × average points`, clamped to 1–10.
2. If no tags match and `ANTHROPIC_API_KEY` is set, asks Claude for a 1–10 rating.
3. Caches the score by track ID, logs the play, and posts it if there's a score.

Tag weights live in `TAG_POINTS` in `src/scoring.js`.

## Setup

You create the three developer apps. The bot can't do that for you.

### 1. Discord bot and sign-in

1. In the Discord Developer Portal, create an application and add a bot. Copy the bot token and the **Client ID** and **Client Secret** (under OAuth2).
2. Under **Bot → Privileged Gateway Intents**, turn on **Presence Intent**.
3. Under **OAuth2 → Redirects**, add `PUBLIC_BASE_URL/auth/discord/callback`.
4. Invite the bot to a server you and your friend share (OAuth2 → URL Generator, scope `bot`, permissions `View Channels` and `Send Messages`).
5. Enable Developer Mode in Discord to copy user IDs and the `#mood` channel ID.

### 2. Spotify

1. At developer.spotify.com/dashboard, create an app.
2. Add the redirect URI `PUBLIC_BASE_URL/auth/spotify/callback`. Spotify requires HTTPS for any address other than `127.0.0.1`.
3. Copy the Client ID and Client Secret.
4. In Development Mode, Spotify limits who can connect. Add your friend's account under the app's user management. The app owner needs Spotify Premium. Spotify's rules changed in 2026, so check the dashboard before you rely on this.

### 3. Last.fm

1. Create an API account at https://www.last.fm/api/account/create.
2. Set the callback URL to `PUBLIC_BASE_URL/auth/lastfm/callback`.
3. Copy the API key and shared secret.

### 4. Configure and run

```bash
cp .env.example .env
# fill in .env, including the two random secrets
npm install
npm start
```

Open `PUBLIC_BASE_URL` and sign in with Discord. Your friend opens the same address on their own device.

`PUBLIC_BASE_URL` has to be an address your friend can reach. `http://localhost:3000` only works on this machine. For a friend, run the bot on a host with HTTPS (a free host, or a tunnel to your home machine).

Requires Node.js 22.13 or newer. Storage uses Node's built-in `node:sqlite`, so there are no native modules to compile.

### Discord install, webhook, and linked roles

In the Developer Portal for the same app:

1. **General Information → Public Key**: copy it into `DISCORD_PUBLIC_KEY`. The bot won't start without it.
2. **Installation → Install Link → Custom URL**: `PUBLIC_BASE_URL/discord/install`. It offers "Add to a server" and "Add to my account".
3. **Webhooks → Webhook URL**: `PUBLIC_BASE_URL/discord/webhook`. Save it, then turn on the events you want (Application Authorized and Deauthorized, Entitlement Create/Update/Delete, and the rest of the list). Discord checks the URL with a signed ping when you save.
4. **Linked Roles → Verification URL** (for later): `PUBLIC_BASE_URL/discord/linked-roles`. It starts the Discord sign-in. Role data isn't written yet.

Every webhook event is saved to the `discord_events` table with its type, time, and full JSON. Installs are `APPLICATION_AUTHORIZED` events, with `integration_type` 0 for a server or 1 for a user:

```bash
sqlite3 data/mood.db "SELECT received_at, json_extract(payload, '$.event.data.integration_type') AS type FROM discord_events WHERE event_type = 'APPLICATION_AUTHORIZED';"
```

### Security notes

- Only Discord IDs in `ALLOWED_DISCORD_IDS` can sign in, so nobody is tracked without being approved.
- OAuth tokens (Spotify refresh tokens) are encrypted in SQLite with `TOKEN_ENCRYPTION_KEY`. Losing that key means friends must reconnect Spotify.
- Disconnecting a service deletes its stored connection. Logged plays are kept.

## Tests

```bash
npm test
```

## Files

- `src/index.js`: Discord client, polling loop, posting
- `src/web.js`: sign-in page and OAuth callbacks
- `src/providers.js`: OAuth URLs, token exchange, now-playing for each service, source priority
- `src/crypto.js`: token encryption and cookie signing
- `src/scoring.js`: tag weights, Last.fm tags, LLM fallback, emoji
- `src/db.js`: SQLite score cache, play log, connections (`data/mood.db` by default)
- `test/`: unit tests for scoring, crypto, source priority, and sign-in routes

## Not yet built

Phase 3 from the project plan (slash commands, bot status, mood board channel) is not built. The sign-in allowlist is a simple env var, not a request-and-accept flow. Adding that would mean a `/track request` command and a DM with Accept/Decline buttons.

## Limitations

- Spotify's own valence data is no longer available to new apps, so scores come from tags or an LLM and are rough guesses.
- Obscure songs often have no Last.fm tags, so the LLM fallback matters.
- Song choice is a weak signal of real mood. Treat this as a joke, not a judgment.
