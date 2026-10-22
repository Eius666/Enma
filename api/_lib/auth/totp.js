'use strict';

// TOTP (RFC 6238) for the admin second factor — no external dependencies,
// Node.js built-in crypto only.

const crypto = require('crypto');

function _totpBase32Decode(base32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = base32.replace(/\s/g, '').toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0;
  const bytes = [];
  for (const c of s) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function _hotpCode(keyBuf, T) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(T / 0x100000000), 0);
  buf.writeUInt32BE(T >>> 0, 4);
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const o = h[19] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o+1] & 0xff) << 16) | ((h[o+2] & 0xff) << 8) | (h[o+3] & 0xff);
  return (n % 1_000_000).toString().padStart(6, '0');
}

// Accepts ±1 time-step window to handle clock skew
function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  const key = _totpBase32Decode(secret);
  const T   = Math.floor(Date.now() / 30_000);
  const t   = String(token).replace(/\s/g, '');
  return [-1, 0, 1].some(d => _hotpCode(key, T + d) === t);
}

// Generates a cryptographically random base32 secret (160 bits)
function generateTotpSecret() {
  const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(20);
  let r = '', bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { r += C[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) r += C[(val << (5 - bits)) & 31];
  return r;
}

module.exports = { verifyTotp, generateTotpSecret };
