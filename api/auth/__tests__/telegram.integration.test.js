'use strict';

// POST /api/auth/telegram against the REAL Firestore emulator: identity
// resolution, account + trial creation and their concurrency guarantees as
// real Firestore enforces them (transactions, create() preconditions, batched
// reads) — what the in-memory mock cannot show.
//   npm run test:auth-integration
//
// AUTH_HANDLER may point at another copy of the handler, so the same scenarios
// can be run against an earlier version and the outcomes compared.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.TELEGRAM_BOT_TOKEN = 'integration-bot-token';
const realAdmin = require('firebase-admin');
if (!realAdmin.apps.length) realAdmin.initializeApp({ projectId: 'enma-rules-test' });
const db = realAdmin.firestore();

// Fault injection: a failing or slow document read. Firestore#getAll is what
// every document read goes through (DocumentReference#get calls it too), so
// any version of the handler meets the same fault.
// Writes and queries can fail too: a canonicalUids write, a batch commit, the
// chatId queries (started early, possibly not needed in the chosen branch).
const faults = { failNextGetAll: 0, failGetAllNo: 0, delayMs: 0, failCanonicalSet: 0, failBatchCommit: 0, failChatIdQuery: 0 };
let getAllCalls = 0;
const unavailable = () => Object.assign(new Error('14 UNAVAILABLE: injected'), { code: 14 });
const { Firestore, DocumentReference, Query, WriteBatch } = require('@google-cloud/firestore');
const originalGetAll = Firestore.prototype.getAll;
Firestore.prototype.getAll = async function (...refs) {
  getAllCalls += 1;
  if (faults.delayMs) await new Promise(r => setTimeout(r, faults.delayMs));
  if (faults.failNextGetAll > 0) { faults.failNextGetAll -= 1; throw unavailable(); }
  if (faults.failGetAllNo && getAllCalls === faults.failGetAllNo) throw unavailable();
  return originalGetAll.apply(this, refs);
};
const originalSet = DocumentReference.prototype.set;
DocumentReference.prototype.set = function (...a) {
  if (faults.failCanonicalSet > 0 && this.path.startsWith('canonicalUids/')) { faults.failCanonicalSet -= 1; return Promise.reject(unavailable()); }
  return originalSet.apply(this, a);
};
// DocumentReference#set commits through a WriteBatch too, so only batches
// that carry a create() (the account creation) are failed here.
const originalCreate = WriteBatch.prototype.create;
WriteBatch.prototype.create = function (...a) { this.__hasCreate = true; return originalCreate.apply(this, a); };
const originalCommit = WriteBatch.prototype.commit;
WriteBatch.prototype.commit = function (...a) {
  if (faults.failBatchCommit > 0 && this.__hasCreate) { faults.failBatchCommit -= 1; return Promise.reject(unavailable()); }
  return originalCommit.apply(this, a);
};
const originalQueryGet = Query.prototype.get;
Query.prototype.get = function (...a) {
  if (faults.failChatIdQuery > 0 && this._queryOptions?.collectionId === 'users' && JSON.stringify(this._queryOptions.filters || '').includes('chatId')) {
    faults.failChatIdQuery -= 1; return Promise.reject(unavailable());
  }
  return originalQueryGet.apply(this, a);
};

// No promise may be left rejected without a handler (e.g. an early read that
// the chosen branch never awaited).
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason && reason.message)); });
const settle = () => new Promise(r => setTimeout(r, 50));

const issuedTokens = [];
const fa = require.resolve('../../_lib/firebaseAdmin');
require.cache[fa] = {
  id: fa, filename: fa, loaded: true,
  exports: {
    db,
    admin: { firestore: realAdmin.firestore, auth: () => ({ createCustomToken: async uid => { issuedTokens.push(uid); return `token-for-${uid}`; } }) },
  },
};
const handler = require(process.env.AUTH_HANDLER || '../telegram');

function initData(telegramId, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramId, first_name: 'Test', username: 'tester' }),
    ...extra,
  });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

async function signIn(telegramId, extra, rawInitData) {
  const res = { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() {} };
  const l = console.log, e = console.error; console.log = () => {}; console.error = () => {};
  try { await handler({ method: 'POST', body: { initData: rawInitData ?? initData(telegramId, extra) }, headers: {} }, res); }
  finally { console.log = l; console.error = e; }
  return res;
}

const COLLECTIONS = ['users', 'subscriptions', 'canonicalUids', 'telegramUsers', 'telegramManualLinks', 'referrals', 'referrers'];
const dump = async () => {
  const out = {};
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) {
      const data = d.data();
      for (const k of ['createdAt', 'updatedAt', 'resolvedAt', 'referralLinkClaimedAt', 'startDate', 'endDate', 'endDateMs', 'trialEndDate', 'trialEndDateMs', 'referralLinkExpiresAt']) if (k in data) data[k] = '<time>';
      out[`${c}/${d.id}`] = data;
    }
  }
  return out;
};
const count = async c => (await db.collection(c).get()).size;
const seed = (path, data) => db.doc(path).set(data);

beforeEach(async () => {
  Object.assign(faults, { failNextGetAll: 0, failGetAllNo: 0, delayMs: 0, failCanonicalSet: 0, failBatchCommit: 0, failChatIdQuery: 0 });
  getAllCalls = 0; issuedTokens.length = 0; unhandled.length = 0;
  // Plain batched deletes (not recursiveDelete), so the suite also runs with
  // the REST transport (FIRESTORE_PREFER_REST=true). No subcollections here.
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    if (!snap.empty) { const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
  }
});

test('a genuinely new Telegram user: one account, one Premium trial, canonical cached, token for that uid', async () => {
  const r = await signIn(1001);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.uid, r.body.isNewUser], ['tg_1001', true]);
  const user = (await db.doc('users/tg_1001').get()).data();
  assert.equal(user.telegramId, 1001);
  assert.equal(user.chatId, 1001);
  assert.equal(user.trialUsed, true);
  const sub = (await db.doc('subscriptions/tg_1001').get()).data();
  assert.equal(sub.trialPlan, 'premium');
  assert.equal(sub.plan, 'free');
  assert.equal(sub.paymentMethod, 'trial');
  // Seven days, ending at the end of that day (computeTrialWindow).
  const trialMs = sub.trialEndDateMs - Date.parse(sub.startDate);
  assert.ok(trialMs > 7 * 86400000 && trialMs <= 8 * 86400000, String(trialMs));
  assert.equal((await db.doc('canonicalUids/tg_1001').get()).data().uid, 'tg_1001');
  assert.deepEqual(issuedTokens, ['tg_1001']);
});

test('an existing user signs in to their uid; nothing is created or changed', async () => {
  await seed('canonicalUids/tg_2002', { uid: 'uidA', telegramId: 2002 });
  await seed('users/uidA', { chatId: 2002, trialUsed: true, name: 'A' });
  await seed('subscriptions/uidA', { plan: 'premium', status: 'active', endDateMs: 4102444800000 });
  const before = await dump();
  const r = await signIn(2002);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.uid, r.body.isNewUser], ['uidA', false]);
  assert.deepEqual(await dump(), before);
});

test('an existing legacy user (no cache, found by chatId) signs in to that uid and gets the cache; no trial added', async () => {
  await seed('users/legacyUid', { chatId: '3003', trialUsed: true });
  await seed('subscriptions/legacyUid', { plan: 'pro', status: 'active' });
  const r = await signIn(3003);
  assert.deepEqual([r.statusCode, r.body.uid, r.body.isNewUser], [200, 'legacyUid', false]);
  assert.equal((await db.doc('canonicalUids/tg_3003').get()).data().uid, 'legacyUid');
  assert.deepEqual((await db.doc('subscriptions/legacyUid').get()).data(), { plan: 'pro', status: 'active' });
  assert.equal(await count('users'), 1);
});

test('profile deleted, only the canonical cache left behind: a fresh account under the same deterministic uid (baseline behaviour)', async () => {
  await seed('canonicalUids/tg_4004', { uid: 'tg_4004', telegramId: 4004 });
  const r = await signIn(4004);
  assert.deepEqual([r.statusCode, r.body.uid, r.body.isNewUser], [200, 'tg_4004', true]);
  assert.ok((await db.doc('subscriptions/tg_4004').get()).exists);
});

test('profile deleted but the telegramUsers mapping left behind: recovery_required, no account, no token, cache untouched', async () => {
  await seed('canonicalUids/tg_5005', { uid: 'oldUid', telegramId: 5005 });
  await seed('telegramUsers/tg_5005', { firebaseUid: 'oldUid', telegramId: 5005 });
  const before = await dump();
  const r = await signIn(5005);
  assert.deepEqual([r.statusCode, r.body.code], [409, 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED']);
  assert.deepEqual(await dump(), before);
  assert.deepEqual(issuedTokens, []);
});

test('a stale canonical uid is not trusted: the live account is used and the cache is corrected', async () => {
  await seed('canonicalUids/tg_6006', { uid: 'goneUid', telegramId: 6006 });
  await seed('users/liveUid', { chatId: 6006 });
  await seed('subscriptions/liveUid', { plan: 'free', status: 'active' });
  const r = await signIn(6006);
  assert.deepEqual([r.statusCode, r.body.uid], [200, 'liveUid']);
  assert.equal((await db.doc('canonicalUids/tg_6006').get()).data().uid, 'liveUid');
  assert.equal((await db.doc('users/goneUid').get()).exists, false);
});

test('a verified manual link wins over the cache and over several legacy candidates', async () => {
  await seed('telegramManualLinks/tg_7007', { verified: true, uid: 'manualUid' });
  await seed('users/manualUid', { email: 'x@example.com' });
  await seed('canonicalUids/tg_7007', { uid: 'otherUid', telegramId: 7007 });
  await seed('users/otherUid', { chatId: 7007 });
  await seed('users/thirdUid', { chatId: '7007' });
  const r = await signIn(7007);
  assert.deepEqual([r.statusCode, r.body.uid], [200, 'manualUid']);
});

test('an unverified manual link is ignored; a verified one to a missing account with no candidates is recovery_required', async () => {
  await seed('telegramManualLinks/tg_7100', { verified: false, uid: 'someUid' });
  await seed('users/someUid', {});
  const unverified = await signIn(7100);
  assert.deepEqual([unverified.statusCode, unverified.body.uid], [200, 'tg_7100']);

  await seed('telegramManualLinks/tg_7200', { verified: true, uid: 'missingUid' });
  const dangling = await signIn(7200);
  assert.deepEqual([dangling.statusCode, dangling.body.code], [409, 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED']);
  assert.equal((await db.doc('users/tg_7200').get()).exists, false);
});

test('two live accounts for one Telegram id: conflict, nothing picked, nothing cached, no token', async () => {
  await seed('users/uidX', { chatId: 8008 });
  await seed('users/uidY', { chatId: '8008' });
  const before = await dump();
  const r = await signIn(8008);
  assert.deepEqual([r.statusCode, r.body.code], [409, 'TELEGRAM_IDENTITY_CONFLICT']);
  assert.deepEqual(await dump(), before);
  assert.deepEqual(issuedTokens, []);
});

test('a stale cache does not hide a conflict between two live accounts', async () => {
  await seed('canonicalUids/tg_8100', { uid: 'goneUid', telegramId: 8100 });
  await seed('users/uidX', { chatId: 8100 });
  await seed('users/uidY', { chatId: '8100' });
  const r = await signIn(8100);
  assert.deepEqual([r.statusCode, r.body.code], [409, 'TELEGRAM_IDENTITY_CONFLICT']);
  assert.equal((await db.doc('canonicalUids/tg_8100').get()).data().uid, 'goneUid');
});

test('20 simultaneous first launches of a new user: one account, one trial, exactly one "new", all to the same uid', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => signIn(9009)));
  assert.ok(results.every(r => r.statusCode === 200 && r.body.uid === 'tg_9009'), JSON.stringify(results.map(r => r.statusCode)));
  assert.equal(results.filter(r => r.body.isNewUser === true).length, 1);
  assert.equal(await count('users'), 1);
  assert.equal(await count('subscriptions'), 1);
});

test('an existing account without a subscription gets the trial once (baseline behaviour), never twice', async () => {
  await seed('canonicalUids/tg_9100', { uid: 'noSubUid', telegramId: 9100 });
  await seed('users/noSubUid', { chatId: 9100, name: 'kept' });
  const first = await signIn(9100);
  const second = await signIn(9100);
  assert.deepEqual([first.body.isNewUser, second.body.isNewUser], [true, false]);
  const user = (await db.doc('users/noSubUid').get()).data();
  assert.equal(user.name, 'kept');
  assert.equal(user.trialUsed, true);
  assert.equal(await count('subscriptions'), 1);
});

test('referral registration: the referral is recorded and the new account still gets exactly one trial', async () => {
  await seed('users/referrerUid', { referralCode: 'FRIEND1' });
  const r = await signIn(9200, { start_param: 'ref_FRIEND1' });
  assert.deepEqual([r.statusCode, r.body.uid, r.body.isNewUser], [200, 'tg_9200', true]);
  const user = (await db.doc('users/tg_9200').get()).data();
  assert.equal(user.referredBy, 'FRIEND1');
  assert.equal(user.trialUsed, true);
  const refs = await db.collection('referrals').where('referredId', '==', 'tg_9200').get();
  assert.equal(refs.size, 1);
  assert.equal(refs.docs[0].data().referrerId, 'referrerUid');
  assert.equal((await db.doc('subscriptions/tg_9200').get()).data().trialPlan, 'premium');
});

test('partner (influencer) registration: attributed, one trial', async () => {
  await seed('referrers/PARTNER', { name: 'Partner' });
  const r = await signIn(9300, { start_param: 'ref_partner' });
  assert.deepEqual([r.statusCode, r.body.isNewUser], [200, true]);
  assert.equal((await db.doc('users/tg_9300').get()).data().referredByInfluencer, 'PARTNER');
  assert.equal(await count('subscriptions'), 1);
});

test('one Firestore request fails: 500, no token, nothing written; the retry then succeeds without duplicates', async () => {
  faults.failNextGetAll = 1;
  const failed = await signIn(9400);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(issuedTokens, []);
  assert.equal(await count('users'), 0);
  assert.equal(await count('subscriptions'), 0);
  const retry = await signIn(9400);
  assert.deepEqual([retry.statusCode, retry.body.uid, retry.body.isNewUser], [200, 'tg_9400', true]);
  assert.equal(await count('users'), 1);
  assert.equal(await count('subscriptions'), 1);
});

test('slow Firestore (300 ms per batched read): same identity, same single account', async () => {
  faults.delayMs = 300;
  await seed('canonicalUids/tg_9500', { uid: 'slowUid', telegramId: 9500 });
  await seed('users/slowUid', { chatId: 9500 });
  await seed('subscriptions/slowUid', { plan: 'free', status: 'active' });
  const r = await signIn(9500);
  assert.deepEqual([r.statusCode, r.body.uid, r.body.isNewUser], [200, 'slowUid', false]);
  assert.equal(await count('users'), 1);
});

test('invalid signature: 401, nothing read into an account, nothing written, no token', async () => {
  const forged = initData(9600).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  const r = await signIn(9600, {}, forged);
  assert.equal(r.statusCode, 401);
  assert.equal(await count('users'), 0);
  assert.deepEqual(issuedTokens, []);
});

// ── concurrency on missing, existing and partial accounts ──────────────────

const twenty = (id, extra) => Promise.all(Array.from({ length: 20 }, () => signIn(id, extra)));

test('20 simultaneous sign-ins of an EXISTING account: all 200 to its uid, none "new", nothing changed', async () => {
  await seed('canonicalUids/tg_10001', { uid: 'uidE', telegramId: 10001 });
  await seed('users/uidE', { chatId: 10001, name: 'Existing', trialUsed: true });
  await seed('subscriptions/uidE', { plan: 'premium', status: 'active', endDateMs: 4102444800000 });
  const before = await dump();
  const results = await twenty(10001);
  assert.ok(results.every(r => r.statusCode === 200 && r.body.uid === 'uidE' && r.body.isNewUser === false));
  assert.deepEqual(await dump(), before);
});

test('20 simultaneous sign-ins of a PARTIAL account (profile without subscription): one trial, profile fields kept', async () => {
  await seed('canonicalUids/tg_10002', { uid: 'uidP', telegramId: 10002 });
  await seed('users/uidP', { chatId: 10002, name: 'Partial', referredBy: 'CODE', currency: 'EUR' });
  const results = await twenty(10002);
  assert.ok(results.every(r => r.statusCode === 200 && r.body.uid === 'uidP'), JSON.stringify(results.map(r => r.statusCode)));
  assert.equal(results.filter(r => r.body.isNewUser === true).length, 1);
  assert.equal(await count('subscriptions'), 1);
  const user = (await db.doc('users/uidP').get()).data();
  assert.deepEqual([user.name, user.referredBy, user.currency, user.chatId, user.trialUsed], ['Partial', 'CODE', 'EUR', 10002, true]);
  assert.equal(await count('users'), 1);
});

test('20 simultaneous first launches when only a stray profile exists (written earlier by a referral): one trial, its fields kept', async () => {
  await seed('users/tg_10003', { referredByInfluencer: 'PARTNER' });
  const results = await twenty(10003);
  assert.ok(results.every(r => r.statusCode === 200 && r.body.uid === 'tg_10003'));
  assert.equal(results.filter(r => r.body.isNewUser === true).length, 1);
  assert.equal(await count('subscriptions'), 1);
  assert.equal((await db.doc('users/tg_10003').get()).data().referredByInfluencer, 'PARTNER');
});

test('a subscription without a profile is never replaced and no second trial appears (baseline behaviour)', async () => {
  const sub = { plan: 'pro', status: 'active', endDateMs: 4102444800000 };
  await seed('subscriptions/tg_10004', sub);
  const results = await twenty(10004);
  assert.ok(results.every(r => r.statusCode === 200 && r.body.uid === 'tg_10004' && r.body.isNewUser === false));
  assert.deepEqual((await db.doc('subscriptions/tg_10004').get()).data(), sub);
  assert.equal(await count('subscriptions'), 1);
});

// ── failures while the cache write and the account creation run together ──

test('the canonical cache write fails: 500 and no token; the retry signs in to the same single account', async () => {
  faults.failCanonicalSet = 1;
  const failed = await signIn(10101);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(issuedTokens, []);
  await settle(); // the account creation that ran alongside may still be landing
  const retry = await signIn(10101);
  assert.deepEqual([retry.statusCode, retry.body.uid], [200, 'tg_10101']);
  assert.equal(await count('users'), 1);
  assert.equal(await count('subscriptions'), 1);
  assert.equal((await db.doc('canonicalUids/tg_10101').get()).data().uid, 'tg_10101');
  await settle();
  assert.deepEqual(unhandled, []);
});

test('creating the account fails: 500 and no token, no partial account; the retry creates it once', async () => {
  faults.failBatchCommit = 1;
  const failed = await signIn(10102);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(issuedTokens, []);
  assert.equal(await count('users'), 0);
  assert.equal(await count('subscriptions'), 0);
  const retry = await signIn(10102);
  assert.deepEqual([retry.statusCode, retry.body.uid, retry.body.isNewUser], [200, 'tg_10102', true]);
  assert.equal(await count('users'), 1);
  assert.equal(await count('subscriptions'), 1);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('a verified manual link is never rewritten, by success or by failure', async () => {
  const link = { verified: true, uid: 'manualUid', note: 'set by admin' };
  await seed('telegramManualLinks/tg_10103', link);
  await seed('users/manualUid', { email: 'x@example.com' });
  await seed('subscriptions/manualUid', { plan: 'free', status: 'active' });
  faults.failChatIdQuery = 2;
  const ok = await signIn(10103);
  assert.deepEqual([ok.statusCode, ok.body.uid], [200, 'manualUid']);
  faults.failGetAllNo = getAllCalls + 1; // the next links read fails
  const failed = await signIn(10103);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual((await db.doc('telegramManualLinks/tg_10103').get()).data(), link);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('a conflict is never turned into a new account, even when a write would fail', async () => {
  await seed('users/uidX', { chatId: 10104 });
  await seed('users/uidY', { chatId: '10104' });
  faults.failCanonicalSet = 5; faults.failBatchCommit = 5;
  const r = await signIn(10104);
  assert.deepEqual([r.statusCode, r.body.code], [409, 'TELEGRAM_IDENTITY_CONFLICT']);
  assert.equal((await db.doc('users/tg_10104').get()).exists, false);
  assert.equal(await count('canonicalUids'), 0);
});

// ── reads started early but not needed in the chosen branch ────────────────

test('the early chatId queries fail but are not needed (existing account): 200, no unhandled rejection', async () => {
  await seed('canonicalUids/tg_10201', { uid: 'uidQ', telegramId: 10201 });
  await seed('users/uidQ', { chatId: 10201 });
  await seed('subscriptions/uidQ', { plan: 'free', status: 'active' });
  faults.failChatIdQuery = 2;
  const r = await signIn(10201);
  assert.deepEqual([r.statusCode, r.body.uid], [200, 'uidQ']);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('the chatId queries fail and ARE needed (new identity): 500, no token, nothing written', async () => {
  faults.failChatIdQuery = 2;
  const r = await signIn(10202);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(issuedTokens, []);
  assert.equal(await count('users'), 0);
  assert.equal(await count('canonicalUids'), 0);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('the account read (second batched read) fails: 500, no token, nothing written', async () => {
  await seed('canonicalUids/tg_10203', { uid: 'uidR', telegramId: 10203 });
  await seed('users/uidR', { chatId: 10203 });
  faults.failGetAllNo = 2; // 1st = links, 2nd = accounts
  const r = await signIn(10203);
  assert.equal(r.statusCode, 500);
  assert.deepEqual(issuedTokens, []);
  assert.equal(await count('subscriptions'), 0);
  await settle();
  assert.deepEqual(unhandled, []);
});
