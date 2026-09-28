'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verifyTelegramLoginWidget,
  issuePartnerSession,
  verifyPartnerSession,
  bearerToken,
} = require('../partnerAuth');

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-abcDEF';

// Independent re-implementation of Telegram's Login Widget signature, so the
// test doesn't just call the same code it's testing.
function signWidgetPayload(fields, botToken) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

function freshPayload(overrides = {}) {
  const fields = {
    id: 555444333,
    first_name: 'Ася',
    username: 'asya_partner',
    auth_date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  return signWidgetPayload(fields, BOT_TOKEN);
}

test('verifyTelegramLoginWidget: accepts a correctly signed, fresh payload', () => {
  const payload = freshPayload();
  const r = verifyTelegramLoginWidget(payload, BOT_TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.user.id, 555444333);
  assert.equal(r.user.username, 'asya_partner');
});

test('verifyTelegramLoginWidget: rejects a tampered field (id swapped after signing)', () => {
  const payload = freshPayload();
  payload.id = 999999999; // hash no longer matches
  const r = verifyTelegramLoginWidget(payload, BOT_TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('verifyTelegramLoginWidget: rejects a payload signed with a different bot token', () => {
  const payload = signWidgetPayload({ id: 1, first_name: 'X', auth_date: Math.floor(Date.now() / 1000) }, 'wrong:token');
  const r = verifyTelegramLoginWidget(payload, BOT_TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('verifyTelegramLoginWidget: rejects a stale auth_date (replay protection)', () => {
  const payload = freshPayload({ auth_date: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60 });
  const r = verifyTelegramLoginWidget(payload, BOT_TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('verifyTelegramLoginWidget: rejects a missing hash / empty payload', () => {
  assert.equal(verifyTelegramLoginWidget({}, BOT_TOKEN).ok, false);
  assert.equal(verifyTelegramLoginWidget(null, BOT_TOKEN).ok, false);
});

test('verifyTelegramLoginWidget: server misconfigured when bot token is absent', () => {
  const payload = freshPayload();
  const r = verifyTelegramLoginWidget(payload, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'server_misconfigured');
});

// ── Session tokens ────────────────────────────────────────────────────────────

test('session token: round-trips and carries the code', () => {
  process.env.PARTNER_SESSION_SECRET = 'test-secret-1';
  const token = issuePartnerSession('K7M2PX');
  const r = verifyPartnerSession(token);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'K7M2PX');
});

test('session token: tampering with the payload invalidates the signature', () => {
  process.env.PARTNER_SESSION_SECRET = 'test-secret-1';
  const token = issuePartnerSession('K7M2PX');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ code: 'OTHERCODE', exp: Date.now() + 999999 })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = verifyPartnerSession(`${forged}.${sig}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('session token: rejects a token signed with a different secret', () => {
  process.env.PARTNER_SESSION_SECRET = 'secret-a';
  const token = issuePartnerSession('K7M2PX');
  process.env.PARTNER_SESSION_SECRET = 'secret-b';
  const r = verifyPartnerSession(token);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('session token: rejects an expired token', () => {
  process.env.PARTNER_SESSION_SECRET = 'test-secret-1';
  // Hand-build an already-expired token using the same signing scheme.
  const payload = { code: 'K7M2PX', exp: Date.now() - 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = crypto.createHmac('sha256', 'test-secret-1').update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = verifyPartnerSession(`${body}.${sig}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('session token: rejects malformed tokens', () => {
  assert.equal(verifyPartnerSession('').ok, false);
  assert.equal(verifyPartnerSession(null).ok, false);
  assert.equal(verifyPartnerSession('no-dot-here').ok, false);
});

test('bearerToken: extracts from Authorization header, null otherwise', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Basic xyz' } }), null);
});
