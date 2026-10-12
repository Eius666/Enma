'use strict';

// Firestore rules for server-owned money fields. Run with the emulator:
//   npm run test:rules
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp } = require('firebase/firestore');

let env;

const V2 = { userId: 'alice', schemaVersion: 2, type: 'expense', amount: 100, currency: 'USD', rubAmount: 8640, fx: { rateToRub: 86.4, source: 'bank_quote' }, description: 'coffee', source: 'web-app' };
const LEGACY = { userId: 'alice', type: 'expense', amount: 5000, currency: 'RUB', description: 'old', source: 'telegram-bot' };
const GOAL_LINKED = {
  userId: 'alice', schemaVersion: 2, type: 'goal_deposit', budgetImpact: false,
  amount: 5000, currency: 'RUB', rubAmount: 5000, fx: null,
  goalId: 'g1', goalTitleSnapshot: 'Car', goalCurrency: 'RUB', amountInGoalCurrency: 5000,
  goalBalanceAfter: 5000, operationId: 'op-1', description: 'Накопления: Car', source: 'web-app',
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'enma-rules-test',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'transactions/v2'), V2);
    await setDoc(doc(db, 'transactions/legacy'), LEGACY);
    await setDoc(doc(db, 'transactions/bobs'), { ...V2, userId: 'bob' });
    await setDoc(doc(db, 'transactions/goallinked'), GOAL_LINKED);
    await setDoc(doc(db, 'goals/g1'), { userId: 'alice', title: 'Car', targetAmount: 1000, currentAmount: 0, currency: 'RUB' });
    // Notes audit: a free-tier counter well under the limit so create
    // tests exercise the real rule, not an incidental 429-equivalent deny.
    await setDoc(doc(db, 'users/alice/freeUsage/counters'), { noteCount: 0 });
    await setDoc(doc(db, 'users/mallory/freeUsage/counters'), { noteCount: 0 });
    await setDoc(doc(db, 'notes/n1'), { userId: 'alice', title: 'Shopping list', content: 'milk, eggs', type: 'text', category: 'General', pinned: false });
  });
});

const alice = () => env.authenticatedContext('alice').firestore();
const mallory = () => env.authenticatedContext('mallory').firestore();
const anon = () => env.unauthenticatedContext().firestore();

// ── create is server-only ────────────────────────────────────────────────────
test('client cannot create a transaction at all (forged rubAmount/fx included)', async () => {
  await assertFails(setDoc(doc(alice(), 'transactions/new1'), { ...V2, rubAmount: 1 }));
  await assertFails(setDoc(doc(alice(), 'transactions/new2'), { userId: 'alice', type: 'expense', amount: 1, currency: 'RUB' }));
});

// ── money fields are immutable for clients ───────────────────────────────────
for (const [field, value] of [['rubAmount', 1], ['amount', 1], ['currency', 'RUB'], ['fx', null], ['schemaVersion', 1], ['type', 'income'], ['userId', 'mallory'], ['source', 'x']]) {
  test(`client cannot change ${field} of an existing transaction`, async () => {
    await assertFails(updateDoc(doc(alice(), 'transactions/v2'), { [field]: value }));
  });
}

// ── goal-transfer fields are also immutable, and a goal-linked tx can't be
//    deleted by the client (would desync the paired goal.currentAmount) ────
for (const [field, value] of [
  ['budgetImpact', true], ['goalTitleSnapshot', 'forged'], ['goalCurrency', 'USD'],
  ['amountInGoalCurrency', 999999], ['goalBalanceAfter', 999999], ['operationId', 'forged'],
  ['goalClosed', true],
]) {
  test(`client cannot change ${field} of a goal-linked transaction`, async () => {
    await assertFails(updateDoc(doc(alice(), 'transactions/goallinked'), { [field]: value }));
  });
}
test('client cannot add a goalId to an existing non-linked transaction', async () => {
  await assertFails(updateDoc(doc(alice(), 'transactions/v2'), { goalId: 'g1' }));
});
test('client cannot delete a goal-linked transaction (would desync the goal balance)', async () => {
  await assertFails(deleteDoc(doc(alice(), 'transactions/goallinked')));
});
test('owner can still edit metadata on a goal-linked transaction', async () => {
  await assertSucceeds(updateDoc(doc(alice(), 'transactions/goallinked'), { description: 'renamed note' }));
});

test('client cannot upgrade a legacy doc to a forged v2 (adding rubAmount/fx/schemaVersion)', async () => {
  await assertFails(updateDoc(doc(alice(), 'transactions/legacy'), { schemaVersion: 2, rubAmount: 999999, fx: { rateToRub: 1 } }));
  await assertFails(updateDoc(doc(alice(), 'transactions/legacy'), { rubAmount: 1 }));
});

test('setDoc-merge with UNCHANGED money values (old client bundle) still works', async () => {
  await assertSucceeds(setDoc(doc(alice(), 'transactions/v2'), { ...V2, description: 'renamed', updatedAt: serverTimestamp() }, { merge: true }));
});

// ── metadata + delete + read ─────────────────────────────────────────────────
test('client can edit metadata (description, category, bank, date)', async () => {
  await assertSucceeds(updateDoc(doc(alice(), 'transactions/v2'), { description: 'new', categoryId: 'p-food', bank: 'T', date: '2026-09-01T10:00:00.000Z' }));
});
test('owner can read and delete own transaction', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'transactions/v2')));
  await assertSucceeds(deleteDoc(doc(alice(), 'transactions/v2')));
});

// ── other users / anonymous ──────────────────────────────────────────────────
test('another user cannot read, edit or delete', async () => {
  await assertFails(getDoc(doc(mallory(), 'transactions/v2')));
  await assertFails(updateDoc(doc(mallory(), 'transactions/v2'), { description: 'hack' }));
  await assertFails(deleteDoc(doc(mallory(), 'transactions/v2')));
});
test('unauthenticated access is denied', async () => {
  await assertFails(getDoc(doc(anon(), 'transactions/v2')));
});

// ── goals: read-only for the owner ───────────────────────────────────────────
test('goals: owner can read, nobody can write from the client', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'goals/g1')));
  await assertFails(updateDoc(doc(alice(), 'goals/g1'), { currentAmount: 1000000 }));
  // currentAmountRub (the FX-neutral cost basis goalTransfer.js maintains)
  // is just as server-owned as currentAmount itself — same blanket lock.
  await assertFails(updateDoc(doc(alice(), 'goals/g1'), { currentAmountRub: 1000000 }));
  await assertFails(setDoc(doc(alice(), 'goals/g2'), { userId: 'alice', title: 'x', targetAmount: 1, currentAmount: 1 }));
  await assertFails(deleteDoc(doc(alice(), 'goals/g1')));
  await assertFails(getDoc(doc(mallory(), 'goals/g1')));
});

// ── notes — ENMA notes-recovery audit, PHASE 6 ──────────────────────────────
// Regression coverage locking in CURRENT, correct behavior (no rules bug
// was found here — these exist so a future change can't silently break it).

test('notes: owner can create their own note within the free limit', async () => {
  await assertSucceeds(setDoc(doc(alice(), 'notes/new1'), {
    userId: 'alice', title: 'New', content: 'hello', type: 'text', category: 'General', pinned: false,
  }));
});

test('notes: create is rejected once the free-tier note limit is reached', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/alice/freeUsage/counters'), { noteCount: 10 });
  });
  await assertFails(setDoc(doc(alice(), 'notes/over-limit'), {
    userId: 'alice', title: 'One too many', content: '', type: 'text', category: 'General', pinned: false,
  }));
});

test('notes: a paid user can create past the free-tier count', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/alice/freeUsage/counters'), { noteCount: 50 });
    await setDoc(doc(ctx.firestore(), 'subscriptions/alice'), { status: 'active', plan: 'pro', endDateMs: Date.now() + 86400000 });
  });
  await assertSucceeds(setDoc(doc(alice(), 'notes/paid-ok'), {
    userId: 'alice', title: 'Still works', content: '', type: 'text', category: 'General', pinned: false,
  }));
});

test('notes: client cannot create a note under someone else\'s userId', async () => {
  await assertFails(setDoc(doc(alice(), 'notes/forged'), {
    userId: 'mallory', title: 'x', content: '', type: 'text', category: 'General', pinned: false,
  }));
});

test('notes: owner can read, update (content, pin, category) and delete their own note', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'notes/n1')));
  await assertSucceeds(updateDoc(doc(alice(), 'notes/n1'), { content: 'milk, eggs, bread', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), 'notes/n1'), { pinned: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), 'notes/n1'), { category: 'Work', updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(alice(), 'notes/n1')));
});

test('notes: client cannot change the userId of an existing note', async () => {
  await assertFails(updateDoc(doc(alice(), 'notes/n1'), { userId: 'mallory' }));
});

test('notes: another user cannot read, update, or delete someone else\'s note', async () => {
  await assertFails(getDoc(doc(mallory(), 'notes/n1')));
  await assertFails(updateDoc(doc(mallory(), 'notes/n1'), { content: 'hacked' }));
  await assertFails(deleteDoc(doc(mallory(), 'notes/n1')));
});

test('notes: unauthenticated access is denied', async () => {
  await assertFails(getDoc(doc(anon(), 'notes/n1')));
  await assertFails(setDoc(doc(anon(), 'notes/anon1'), { userId: 'nobody', title: 'x', content: '', type: 'text', category: 'General', pinned: false }));
});
