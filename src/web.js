// Sign-in page and OAuth callbacks. The friend signs in with Discord, then connects Spotify and/or Last.fm.
const http = require('node:http');
const crypto = require('node:crypto');
const { sign, checkSig } = require('./crypto');

const THIRTY_DAYS = 60 * 60 * 24 * 30;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const nonce = () => crypto.randomBytes(16).toString('base64url');

const STYLE = `body{font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:16px;line-height:1.4}
.btn,button{display:block;width:100%;box-sizing:border-box;padding:12px;margin:10px 0;border-radius:8px;
background:#2b6cb0;color:#fff;text-align:center;text-decoration:none;border:0;font-size:16px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #ddd}
.row form{margin:0}.row button{width:auto;margin:0;padding:6px 10px;background:#777}
small{color:#666}`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${STYLE}</style></head><body>${body}</body></html>`;
}

const message = (text) => `<p>${esc(text)}</p><p><a href="/">Back to start</a></p>`;

function createWeb({ env, db, sealer, auth, allowed }) {
  const secure = env.PUBLIC_BASE_URL.startsWith('https://');
  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const send = (res, status, html, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  };
  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { location: to, ...headers });
    res.end();
  };
  const signedUid = (id) => `${id}.${sign(env.SESSION_SECRET, id)}`;
  const readUid = (cookies) => {
    const v = cookies.uid;
    if (!v) return null;
    const i = v.lastIndexOf('.');
    const id = v.slice(0, i);
    return checkSig(env.SESSION_SECRET, id, v.slice(i + 1)) ? id : null;
  };
  const parseCookies = (req) => Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2),
  );
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  function signInPage() {
    return page('Mood bot', `<h1>Mood bot</h1>
<p>Sign in with Discord to start. Then connect Spotify or Last.fm if you like.</p>
<a class="btn" href="/auth/discord/login">Sign in with Discord</a>`);
  }

  function home(res, uid) {
    const conns = Object.fromEntries(uid ? db.getConnections(uid).map((c) => [c.provider, c]) : []);
    if (!conns.discord) return send(res, 200, signInPage());
    const card = (provider, label) => conns[provider]
      ? `<div class="row"><span>${label}: <b>${esc(conns[provider].account)}</b></span>
<form method="post" action="/disconnect"><input type="hidden" name="provider" value="${provider}">
<button>Disconnect</button></form></div>`
      : `<div class="row"><span>${label}</span><a href="/auth/${provider}/login">Connect</a></div>`;
    return send(res, 200, page('Mood bot', `<h1>Hi ${esc(conns.discord.account)}</h1>
<p>Connect as many as you like. The bot uses the first one that's playing, in this order: Discord, Spotify, Last.fm.</p>
<div class="row"><span>Discord: <b>${esc(conns.discord.account)}</b></span><small>Share a server with the bot</small></div>
${card('spotify', 'Spotify')}${card('lastfm', 'Last.fm')}`));
  }

  function login(provider, res, uid) {
    if (provider !== 'discord' && !uid) return redirect(res, '/');
    const state = nonce();
    const url = { discord: auth.discordLogin, spotify: auth.spotifyLogin, lastfm: auth.lastfmLogin }[provider](state);
    return redirect(res, url, { 'set-cookie': cookie('oauth_state', state, 600) });
  }

  async function callback(provider, url, res, cookies, uid) {
    const clear = cookie('oauth_state', '', 0);
    const state = url.searchParams.get('state');
    if (!state || state !== cookies.oauth_state) {
      return send(res, 400, page('Expired', message('That sign-in link expired. Start again from the home page.')),
        { 'set-cookie': clear });
    }
    if (url.searchParams.get('error')) return redirect(res, '/', { 'set-cookie': clear });

    if (provider === 'discord') {
      const me = await auth.discordExchange(url.searchParams.get('code'));
      if (!allowed.has(me.id)) {
        return send(res, 403, page('Not allowed', message("This Discord account isn't on the allowlist.")),
          { 'set-cookie': clear });
      }
      db.saveConnection(me.id, 'discord', me.name, null);
      return redirect(res, '/', { 'set-cookie': [clear, cookie('uid', signedUid(me.id), THIRTY_DAYS)] });
    }

    if (!uid) {
      return send(res, 400, page('Sign in first', message('Sign in with Discord first.')), { 'set-cookie': clear });
    }
    if (provider === 'spotify') {
      const { name, refresh } = await auth.spotifyExchange(url.searchParams.get('code'));
      db.saveConnection(uid, 'spotify', name, sealer.seal(refresh));
    } else {
      const name = await auth.lastfmSession(url.searchParams.get('token'));
      db.saveConnection(uid, 'lastfm', name, null);
    }
    return redirect(res, '/', { 'set-cookie': clear });
  }

  async function disconnect(req, res, uid) {
    if (!uid) return redirect(res, '/');
    const provider = new URLSearchParams(await readBody(req)).get('provider');
    if (provider === 'spotify' || provider === 'lastfm') db.deleteConnection(uid, provider);
    return redirect(res, '/');
  }

  async function route(req, res) {
    const url = new URL(req.url, env.PUBLIC_BASE_URL);
    const cookies = parseCookies(req);
    const uid = readUid(cookies);
    const m = url.pathname.match(/^\/auth\/(discord|spotify|lastfm)\/(login|callback)$/);

    if (req.method === 'GET' && url.pathname === '/') return home(res, uid);
    if (req.method === 'POST' && url.pathname === '/disconnect') return disconnect(req, res, uid);
    if (req.method === 'GET' && m && m[2] === 'login') return login(m[1], res, uid);
    if (req.method === 'GET' && m) return callback(m[1], url, res, cookies, uid);
    return send(res, 404, page('Not found', message('Not found.')));
  }

  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      console.error('web error:', err.message);
      if (!res.headersSent) send(res, 500, page('Error', message('Something went wrong. Try again.')));
    }
  });
}

module.exports = { createWeb };
