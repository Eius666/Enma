'use strict';

// Unit tests for the payment API ID-token authenticator. The verifier is injected, so
// no Firebase project / network is involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authenticatePaymentRequest } = require('../paymentAuth');

const JWT = 'aaaa.bbbb.cccc';
const reqWith = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } });

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return fn().then(
    (r) => { console.log = orig; return { r, lines }; },
    (e) => { console.log = orig; throw e; },
  );
}
const failing = (code) => async () => { const e = new Error('boom'); if (code) e.code = code; throw e; };

test('no Authorization header: request passes through with uid null, event logged', async () => {
  const { r, lines } = await captureLogs(() => authenticatePaymentRequest(reqWith(undefined), { action: 'create', bodyUserId: 'u1' }, { verifyIdToken: failing() }));
  assert.deepEqual({ ok: r.ok, uid: r.uid, mode: r.mode }, { ok: true, uid: null, mode: 'missing' });
  assert.match(lines.join('\n'), /payment_auth_missing/);
});

test('empty Authorization header is treated as missing', async () => {
  const r = await authenticatePaymentRequest(reqWith(''), { action: 'trial' }, { verifyIdToken: failing() });
  assert.equal(r.mode, 'missing');
});

test('required=true rejects a missing token with 401', async () => {
  const r = await authenticatePaymentRequest(reqWith(undefined), { action: 'create', required: true }, {});
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: false, status: 401 });
});

test('valid token, matching body userId: verified, uid from the token', async () => {
  const { r, lines } = await captureLogs(() => authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create', bodyUserId: 'u1' }, { verifyIdToken: async () => ({ uid: 'u1' }) }));
  assert.deepEqual({ ok: r.ok, uid: r.uid, mode: r.mode }, { ok: true, uid: 'u1', mode: 'verified' });
  assert.match(lines.join('\n'), /payment_auth_verified/);
});

test('valid token without body userId: uid comes from the token', async () => {
  const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'trial' }, { verifyIdToken: async () => ({ uid: 'u9' }) });
  assert.equal(r.uid, 'u9');
});

test('valid token, different body userId: 403 and a mismatch event', async () => {
  const { r, lines } = await captureLogs(() => authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create', bodyUserId: 'user-b' }, { verifyIdToken: async () => ({ uid: 'user-a' }) }));
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: false, status: 403 });
  assert.match(lines.join('\n'), /payment_auth_uid_mismatch/);
});

test('expired token: 401 token_expired', async () => {
  const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create' }, { verifyIdToken: failing('auth/id-token-expired') });
  assert.deepEqual({ status: r.status, error: r.error }, { status: 401, error: 'token_expired' });
});

test('bad signature / wrong project (Admin SDK argument-error): 401', async () => {
  for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-revoked', 'auth/user-disabled']) {
    const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create', bodyUserId: 'u1' }, { verifyIdToken: failing(code) });
    assert.equal(r.status, 401, code);
    assert.equal(r.ok, false);
  }
});

test('malformed Authorization values: 401 and the verifier is never called', async () => {
  let called = 0;
  const deps = { verifyIdToken: async () => { called++; return { uid: 'u1' }; } };
  for (const h of ['Bearer', 'Bearer ', 'bearer aaaa.bbbb.cccc', 'Basic dXNlcjpwYXNz', 'Bearer notajwt', 'Bearer a.b', 'Bearer a.b.c d', JWT, 'Bearer a.b.c.d']) {
    const r = await authenticatePaymentRequest(reqWith(h), { action: 'create', bodyUserId: 'u1' }, deps);
    assert.equal(r.ok, false, h);
    assert.equal(r.status, 401, h);
  }
  assert.equal(called, 0);
});

test('an invalid token is never treated as an absent token', async () => {
  const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create', bodyUserId: 'u1' }, { verifyIdToken: failing('auth/argument-error') });
  assert.equal(r.ok, false);
  assert.equal(r.uid, undefined);
});

test('verifier without a uid in the decoded token: 401', async () => {
  const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create' }, { verifyIdToken: async () => ({}) });
  assert.equal(r.status, 401);
});

test('Firebase Admin / infrastructure failure: controlled 503, no fallback', async () => {
  for (const code of [undefined, 'app/network-error', 'auth/internal-error']) {
    const r = await authenticatePaymentRequest(reqWith(`Bearer ${JWT}`), { action: 'create', bodyUserId: 'u1' }, { verifyIdToken: failing(code) });
    assert.deepEqual({ ok: r.ok, status: r.status, error: r.error }, { ok: false, status: 503, error: 'auth_unavailable' });
  }
});

test('logs never contain the token, the Authorization header, the uid or error messages', async () => {
  const secretToken = 'sEcReT.PaYlOaD.SiGnAtUrE';
  const { lines } = await captureLogs(async () => {
    await authenticatePaymentRequest(reqWith(`Bearer ${secretToken}`), { action: 'create', bodyUserId: 'user-b-uid' }, { verifyIdToken: async () => ({ uid: 'user-a-uid' }) });
    await authenticatePaymentRequest(reqWith(`Bearer ${secretToken}`), { action: 'create' }, { verifyIdToken: failing('auth/argument-error') });
    await authenticatePaymentRequest(reqWith(`Bearer ${secretToken}`), { action: 'trial' }, { verifyIdToken: async () => { const e = new Error(`leak ${secretToken}`); e.code = 'x'; throw e; } });
    await authenticatePaymentRequest(reqWith('Bearer garbage'), { action: 'trial' }, {});
    await authenticatePaymentRequest(reqWith(`Bearer ${secretToken}`), { action: 'trial' }, { verifyIdToken: async () => ({ uid: 'ok-uid' }) });
  });
  const all = lines.join('\n');
  assert.ok(lines.length >= 5);
  for (const needle of [secretToken, 'sEcReT', 'Bearer', 'user-b-uid', 'user-a-uid', 'ok-uid', 'leak']) {
    assert.ok(!all.includes(needle), `log leaked: ${needle}`);
  }
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});
