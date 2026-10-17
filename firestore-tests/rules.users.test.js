'use strict';

// users/{uid}: server-owned fields cannot be written by clients.
// Run with the emulator:  npm run test:rules
const { test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, getDoc, deleteField, serverTimestamp } = require('firebase/firestore');

let env;

// Must stay in sync with protectedUserKeys() in firestore.rules.
const PROTECTED = {
  referralBalance: 100000,
  balance: 5000,
  isPro: true,
  trialUsed: false,
  subscription: { plan: 'premium', status: 'active' },
  status: 'active',
  promoCode: 'FREE100',
  referredBy: 'ABCD1234',
  referredByInfluencer: 'INFL',
  referredByInfluencerPlatform: 'telegram',
  referralCode: 'ZZZZ9999',
  referralLink: 'https://t.me/x?start=ref_ZZZZ9999',
  referralLinkClaimedAt: 'now',
  totalReferralEarnedRub: 999999,
  totalEarningsUsd: 999,
  totalPaidUsd: 1,
  pendingPayoutUsd: 999,
  tonWalletAddress: 'UQother',
  chatId: 111,
  telegramId: 111,
  telegramChatId: 111,
  uid: 'someone-else',
  createdAt: 'x',
};

// Server-written baseline of an existing Telegram-created account.
const SERVER_DOC = {
  uid: 'tg_42', telegramId: 42, chatId: 42, isPro: false, trialUsed: true,
  referralBalance: 10, balance: 0, status: 'active', currency: 'RUB', banks: ['A'],
};

before(async () => {
  env = await initializeTestEnvironment({
    // Distinct project id: clearFirestore() in rules.test.js must not wipe this file's data.
    projectId: 'enma-rules-test-users',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/tg_42'), SERVER_DOC);
    await setDoc(doc(db, 'users/email1'), { currency: 'USD', banks: [], isPro: false });
    await setDoc(doc(db, 'users/tg_42/freeUsage/counters'), { noteCount: 0 });
    await setDoc(doc(db, 'users/tg_42/workspaces/w1'), { name: 'W' });
    await setDoc(doc(db, 'users/tg_42/aiChats/c1'), { m: 1 });
  });
});

const owner = () => env.authenticatedContext('tg_42').firestore();
const email1 = () => env.authenticatedContext('email1').firestore();
const mallory = () => env.authenticatedContext('mallory').firestore();
const anon = () => env.unauthenticatedContext().firestore();

// ── create ───────────────────────────────────────────────────────────────────
test('create: a fresh account may be created with only client fields', async () => {
  await assertSucceeds(setDoc(doc(mallory(), 'users/mallory'), { currency: 'EUR', banks: ['X'], updatedAt: serverTimestamp() }));
});
test('create: isPro:true is rejected', async () => {
  await assertFails(setDoc(doc(mallory(), 'users/mallory'), { isPro: true }));
});
for (const [field, value] of Object.entries(PROTECTED)) {
  test(`create: protected field ${field} is rejected`, async () => {
    await assertFails(setDoc(doc(mallory(), 'users/mallory'), { currency: 'RUB', [field]: value }));
  });
}

// ── update / merge ───────────────────────────────────────────────────────────
for (const [field, value] of Object.entries(PROTECTED)) {
  test(`updateDoc: changing/adding ${field} is rejected`, async () => {
    await assertFails(updateDoc(doc(owner(), 'users/tg_42'), { [field]: value === SERVER_DOC[field] ? 'changed' : value }));
  });
  test(`setDoc merge: changing/adding ${field} is rejected`, async () => {
    await assertFails(setDoc(doc(owner(), 'users/tg_42'), { [field]: value === SERVER_DOC[field] ? 'changed' : value }, { merge: true }));
  });
}
test('referralBalance: a client cannot set a large value, existing value unchanged', async () => {
  await assertFails(updateDoc(doc(owner(), 'users/tg_42'), { referralBalance: 1000000 }));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'users/tg_42'));
    if (snap.data().referralBalance !== 10) throw new Error('referralBalance was modified');
  });
});
test('trialUsed / chatId / telegramId can be neither reset nor deleted via deleteField', async () => {
  for (const f of ['trialUsed', 'chatId', 'telegramId', 'referralBalance', 'isPro']) {
    await assertFails(updateDoc(doc(owner(), 'users/tg_42'), { [f]: deleteField() }));
  }
});
test('full overwrite (setDoc without merge) that drops protected fields is rejected', async () => {
  await assertFails(setDoc(doc(owner(), 'users/tg_42'), { currency: 'USD' }));
});
test('full overwrite that keeps protected fields byte-identical is not an affected key (allowed)', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42'), { ...SERVER_DOC, currency: 'USD' }));
});
test('full overwrite that tampers one protected field is rejected', async () => {
  await assertFails(setDoc(doc(owner(), 'users/tg_42'), { ...SERVER_DOC, referralBalance: 99999 }));
});
test('mixed write: a legitimate field plus one protected field is rejected as a whole', async () => {
  await assertFails(updateDoc(doc(owner(), 'users/tg_42'), { currency: 'EUR', isPro: true }));
  await assertFails(setDoc(doc(owner(), 'users/tg_42'), { currency: 'EUR', trialUsed: false }, { merge: true }));
});

// ── legitimate client operations (App.tsx) ───────────────────────────────────
test('currency / banks / updatedAt are writable (setDoc merge, as App.tsx does)', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42'), { currency: 'USD', updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42'), { banks: ['A', 'B'], updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(updateDoc(doc(owner(), 'users/tg_42'), { currency: 'EUR' }));
});
test('legacy chatId sync with the SAME value (Telegram-created account) still passes', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42'), { chatId: 42, updatedAt: serverTimestamp() }, { merge: true }));
});
test('chatId write that differs from the stored value is rejected', async () => {
  await assertFails(setDoc(doc(owner(), 'users/tg_42'), { chatId: 43, updatedAt: serverTimestamp() }, { merge: true }));
});
test('email account: first-time chatId write from the client is rejected', async () => {
  await assertFails(setDoc(doc(email1(), 'users/email1'), { chatId: 555, updatedAt: serverTimestamp() }, { merge: true }));
});
test('email account may still change currency/banks', async () => {
  await assertSucceeds(setDoc(doc(email1(), 'users/email1'), { currency: 'EUR', updatedAt: serverTimestamp() }, { merge: true }));
});

// ── read / delete / other users ──────────────────────────────────────────────
test('owner can read their own document', async () => {
  await assertSucceeds(getDoc(doc(owner(), 'users/tg_42')));
});
test('another user cannot read, create, update or delete someone else\'s document', async () => {
  await assertFails(getDoc(doc(mallory(), 'users/tg_42')));
  await assertFails(updateDoc(doc(mallory(), 'users/tg_42'), { currency: 'USD' }));
  await assertFails(setDoc(doc(mallory(), 'users/tg_42'), { currency: 'USD' }, { merge: true }));
  await assertFails(setDoc(doc(mallory(), 'users/brand-new'), { currency: 'USD' }));
  await assertFails(deleteDoc(doc(mallory(), 'users/tg_42')));
});
test('unauthenticated access is denied', async () => {
  await assertFails(getDoc(doc(anon(), 'users/tg_42')));
  await assertFails(setDoc(doc(anon(), 'users/tg_42'), { currency: 'USD' }, { merge: true }));
});
test('client cannot delete the user document (including their own)', async () => {
  await assertFails(deleteDoc(doc(owner(), 'users/tg_42')));
  await assertFails(deleteDoc(doc(email1(), 'users/email1')));
});

// ── subcollections are unchanged ─────────────────────────────────────────────
test('subcollections keep their previous behaviour', async () => {
  await assertSucceeds(getDoc(doc(owner(), 'users/tg_42/freeUsage/counters')));
  await assertFails(setDoc(doc(owner(), 'users/tg_42/freeUsage/counters'), { noteCount: 0 }));
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42/workspaces/w2'), { name: 'W2' }));
  await assertSucceeds(setDoc(doc(owner(), 'users/tg_42/aiChats/c2'), { m: 2 }));
  await assertFails(getDoc(doc(mallory(), 'users/tg_42/workspaces/w1')));
});
