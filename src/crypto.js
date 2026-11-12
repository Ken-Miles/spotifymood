// Crypto helpers: encrypt stored tokens at rest, and sign the login cookie so it can't be forged.
const crypto = require('node:crypto');

// key: 32 random bytes, base64 encoded (TOKEN_ENCRYPTION_KEY)
function makeSealer(keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded');
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function checkSig(secret, value, sig) {
  const expected = Buffer.from(sign(secret, value));
  const given = Buffer.from(String(sig ?? ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { makeSealer, sign, checkSig };
