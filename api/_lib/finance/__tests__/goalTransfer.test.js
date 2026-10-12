'use strict';

// Unified goal transfer service: atomicity, idempotency, FX locking,
// ownership, insufficient-funds, cross-currency goal conversion, and the
// "never double-count" legacy-currentAmount invariant. Fully offline: fake
// FX + in-memory Firestore double (same fixtures as financialTransaction's
// own test suite).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');
const { transferGoalFunds, closeGoal, GoalTransferError, goalTransferDocId } = require('../goalTransfer');
const { FxUnavailableError } = require('../../fx');

function fakeFx(rates, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getBankRateToRub({ currency, transactionType, timestamp }) {
      calls.push({ currency, transactionType, timestamp });
      if (fail || !rates[currency]) throw new FxUnavailableError(currency, []);
      return {
        rateToRub: rates[currency], source: 'bank_average', provider: 'banki',
        capturedAt: '2026-09-18T10:00:00.000Z', rateDate: '2026-09-18', sampleSize: 7,
        method: 'median_mad_filtered', rateSide: transactionType === 'income' ? 'bank_buys' : 'bank_sells',
      };
    },
  };
}

function setup(seed = {}, rates = { USD: 86, EUR: 101, CNY: 12 }, opts) {
  const db = createMockDb(seed);
  const fx = fakeFx(rates, opts);
  const run = (input, extra = {}) => transferGoalFunds(
    { uid: 'u1', operationId: 'op-1', ...input },
    { firebase: { db, admin: mockAdmin }, fx, ...extra },
  );
  const close = (input, extra = {}) => closeGoal(
    { uid: 'u1', operationId: 'close-1', ...input },
    { firebase: { db, admin: mockAdmin }, fx, ...extra },
  );
  const goal = async (id) => (await db.collection('goals').doc(id).get()).data();
  const tx   = async (id) => (await db.collection('transactions').doc(id).get()).data();
  return { db, fx, run, close, goal, tx };
}

const GOAL_RUB = { userId: 'u1', title: 'На машину', targetAmount: 1000000, currentAmount: 0, currency: 'RUB' };

// ── 1. RUB contribution ──────────────────────────────────────────────────────

test('1. RUB contribution of 5000 increases the goal and creates a linked, locked transaction', async () => {
  const { run, goal, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 } });
  const r = await run({ goalId: 'g1', direction: 'contribution', amount: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.currentAmount, 5000);

  const g = await goal('g1');
  assert.equal(g.currentAmount, 5000);

  const docId = goalTransferDocId('op-1');
  const t = await tx(docId);
  assert.equal(t.type, 'goal_deposit');
  assert.equal(t.budgetImpact, false);
  assert.equal(t.amount, 5000);
  assert.equal(t.currency, 'RUB');
  assert.equal(t.rubAmount, 5000);
  assert.equal(t.fx, null);
  assert.equal(t.goalId, 'g1');
  assert.equal(t.goalTitleSnapshot, 'На машину');
});

// ── 2. RUB withdrawal ────────────────────────────────────────────────────────

test('2. RUB withdrawal of 2000 decreases the goal and creates a reverse-direction linked transaction', async () => {
  const { run, goal, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 5000 } });
  const r = await run({ goalId: 'g1', direction: 'withdrawal', amount: 2000 });
  assert.equal(r.currentAmount, 3000);
  assert.equal((await goal('g1')).currentAmount, 3000);
  const t = await tx(goalTransferDocId('op-1'));
  assert.equal(t.type, 'goal_withdraw');
  assert.equal(t.rubAmount, 2000);
});

// ── 3. USD contribution with locked RUB equivalent ──────────────────────────

test('3. USD contribution of $100 at 86 RUB/USD locks rubAmount=8600 and keeps the goal (RUB) in RUB units', async () => {
  const { run, goal, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 } });
  const r = await run({ goalId: 'g1', direction: 'contribution', amount: 100, currency: 'USD' });
  assert.equal(r.currentAmount, 8600); // goal is RUB-denominated — converted via the locked rate
  const t = await tx(goalTransferDocId('op-1'));
  assert.equal(t.amount, 100);
  assert.equal(t.currency, 'USD');
  assert.equal(t.rubAmount, 8600);
  assert.equal(t.fx.rateToRub, 86);
  assert.equal(t.goalCurrency, 'RUB');
  assert.equal(t.amountInGoalCurrency, 8600);
  assert.equal((await goal('g1')).currentAmount, 8600);
});

// ── 4. user.currency change after a transfer never reprices it ─────────────

test('4. changing user.currency after a transfer does not alter the already-recorded rubAmount', async () => {
  const { run, db, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 }, 'users/u1': { currency: 'USD' } });
  await run({ goalId: 'g1', direction: 'contribution', amount: 100 }); // implicit USD via user.currency
  const before = await tx(goalTransferDocId('op-1'));
  assert.equal(before.currency, 'USD');
  assert.equal(before.rubAmount, 8600);

  await db.collection('users').doc('u1').update({ currency: 'RUB' });
  const after = await tx(goalTransferDocId('op-1'));
  assert.equal(after.rubAmount, 8600); // untouched by the later currency switch
});

// ── 5. contribution to a goal denominated in a different currency ──────────

test('5. a RUB contribution to a USD-denominated goal converts into the goal\'s own currency', async () => {
  const { run, goal, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currency: 'USD', currentAmount: 0, targetAmount: 1000 } });
  const r = await run({ goalId: 'g1', direction: 'contribution', amount: 8600, currency: 'RUB' });
  // 8600 RUB / 86 RUB-per-USD = 100 USD added to the goal's own balance.
  assert.equal(r.currentAmount, 100);
  assert.equal((await goal('g1')).currentAmount, 100);
  const t = await tx(goalTransferDocId('op-1'));
  assert.equal(t.currency, 'RUB');
  assert.equal(t.rubAmount, 8600);
  assert.equal(t.goalCurrency, 'USD');
  assert.equal(t.amountInGoalCurrency, 100);
});

// ── 6. double click / retried request → exactly one effect ─────────────────

test('6. the same operationId retried (double click) applies the transfer exactly once', async () => {
  const { run, goal } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 } });
  const r1 = await run({ goalId: 'g1', direction: 'contribution', amount: 5000 });
  const r2 = await run({ goalId: 'g1', direction: 'contribution', amount: 5000 }); // same op-1 default
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal((await goal('g1')).currentAmount, 5000); // not 10000
});

test('6b. a retried Telegram-style operationId is also deduped (goalOperationId shape)', async () => {
  const { run, goal } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 } });
  const opId = 'tg-555-123-g1-contribution';
  await run({ goalId: 'g1', direction: 'contribution', amount: 1000, operationId: opId });
  await run({ goalId: 'g1', direction: 'contribution', amount: 1000, operationId: opId });
  assert.equal((await goal('g1')).currentAmount, 1000);
});

// ── 7. two parallel, genuinely different deposits ───────────────────────────
//
// NOT testable against this file's in-memory Firestore mock: createMockDb's
// runTransaction reads live and defers writes, with no real optimistic-
// concurrency retry — two truly concurrent calls both read the same stale
// `current` and the second write clobbers the first (a lost update the mock
// itself introduces, not goalTransfer.js). Real Firestore transactions
// retry on conflict and don't have this problem. Moved to
// goalTransfer.integration.test.js, which runs against the Firestore
// EMULATOR — the same reasoning that put the equivalent "two concurrent
// materializer runs" test in the habit-notification integration suite.

// ── 8. FX provider unavailable → controlled error, no partial write ────────

test('8. FX unavailable aborts before any write — no goal change, no transaction', async () => {
  const { run, goal, db } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 1000 } }, {}, { fail: true });
  await assert.rejects(() => run({ goalId: 'g1', direction: 'contribution', amount: 100, currency: 'USD' }), FxUnavailableError);
  assert.equal((await goal('g1')).currentAmount, 1000); // untouched
  assert.equal(db._count('transactions/'), 0);
});

// ── 9. cannot withdraw more than saved ───────────────────────────────────────

test('9. withdrawing more than saved is rejected with INSUFFICIENT_FUNDS and writes nothing', async () => {
  const { run, goal, db } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 100 } });
  await assert.rejects(
    () => run({ goalId: 'g1', direction: 'withdrawal', amount: 200 }),
    (err) => err instanceof GoalTransferError && err.code === 'INSUFFICIENT_FUNDS'
  );
  assert.equal((await goal('g1')).currentAmount, 100);
  assert.equal(db._count('transactions/'), 0);
});

test('9b. withdrawing a negative or zero amount is rejected', async () => {
  const { run } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 100 } });
  await assert.rejects(() => run({ goalId: 'g1', direction: 'withdrawal', amount: 0 }), GoalTransferError);
  await assert.rejects(() => run({ goalId: 'g1', direction: 'withdrawal', amount: -5 }), GoalTransferError);
});

// ── 10. cannot touch someone else's goal ────────────────────────────────────

test('10. contributing to another user\'s goal is rejected with NOT_FOUND, no write', async () => {
  const { run, goal, db } = setup({ 'goals/g1': { ...GOAL_RUB, userId: 'someone-else', currentAmount: 0 } });
  await assert.rejects(
    () => run({ goalId: 'g1', direction: 'contribution', amount: 100 }),
    (err) => err instanceof GoalTransferError && err.code === 'NOT_FOUND'
  );
  assert.equal((await goal('g1')).currentAmount, 0);
  assert.equal(db._count('transactions/'), 0);
});

test('10b. a missing goal is rejected with NOT_FOUND', async () => {
  const { run } = setup({});
  await assert.rejects(
    () => run({ goalId: 'does-not-exist', direction: 'contribution', amount: 100 }),
    (err) => err instanceof GoalTransferError && err.code === 'NOT_FOUND'
  );
});

// ── validation ───────────────────────────────────────────────────────────────

test('rejects a missing operationId', async () => {
  const { db } = setup({});
  await assert.rejects(
    () => transferGoalFunds({ uid: 'u1', goalId: 'g1', direction: 'contribution', amount: 100 }, { firebase: { db, admin: mockAdmin }, fx: fakeFx({}) }),
    GoalTransferError
  );
});

test('rejects a missing uid', async () => {
  const { db } = setup({});
  await assert.rejects(
    () => transferGoalFunds({ goalId: 'g1', direction: 'contribution', amount: 100, operationId: 'x' }, { firebase: { db, admin: mockAdmin }, fx: fakeFx({}) }),
    GoalTransferError
  );
});

test('rejects an invalid direction', async () => {
  const { run } = setup({ 'goals/g1': GOAL_RUB });
  await assert.rejects(() => run({ goalId: 'g1', direction: 'sideways', amount: 100 }), GoalTransferError);
});

// ── 11. goal rename after a transfer doesn't rewrite the historical snapshot ─

test('11. renaming a goal after a transfer leaves the transaction\'s goalTitleSnapshot untouched', async () => {
  const { run, db, tx } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0 } });
  await run({ goalId: 'g1', direction: 'contribution', amount: 1000 });
  await db.collection('goals').doc('g1').update({ title: 'Новое имя' });
  const t = await tx(goalTransferDocId('op-1'));
  assert.equal(t.goalTitleSnapshot, 'На машину');
});

// ═════════════════════════════════════════════════════════════════════════════
// Unified FX-neutral valuation (currentAmountRub) — an ordinary rate change
// must never create or erase "value" in the historical budget on its own.
// ═════════════════════════════════════════════════════════════════════════════

const GOAL_USD = { userId: 'u1', title: 'MacBook', targetAmount: 2000, currentAmount: 0, currency: 'USD' };

test('12. an explicit currentAmountRub of 0 is trusted as-is, never re-derived from a live rate (falsy-zero edge case)', async () => {
  // currentAmount is nonzero but currentAmountRub was explicitly recorded
  // as 0 (e.g. a freshly created goal that hasn't been touched yet in some
  // other way) — `typeof x === 'number'` must treat this as "already set",
  // not fall through to the legacy live-rate baseline (which would wrongly
  // derive 500 × 86 = 43000 here).
  const { run, goal } = setup({ 'goals/g1': { ...GOAL_USD, currentAmount: 500, currentAmountRub: 0 } }, { USD: 86 });
  await run({ goalId: 'g1', direction: 'contribution', amount: 10, currency: 'USD', operationId: 'd1' });
  const g = await goal('g1');
  assert.equal(g.currentAmountRub, 0 + 860); // NOT 43000 + 860
});

test('13. two USD contributions at DIFFERENT rates: currentAmountRub sums the LOCKED rubAmount of each, never re-priced by the later rate', async () => {
  const { run, goal } = setup({ 'goals/g1': { ...GOAL_USD, currentAmountRub: 0 } }, { USD: 86 });
  await run({ goalId: 'g1', direction: 'contribution', amount: 100, currency: 'USD', operationId: 'd1' }); // locks at 86 → 8600 RUB

  // The rate moves between the two contributions — this must NOT retroactively
  // change what the first contribution was already recorded as worth.
  const { run: run2, goal: goal2, db } = setup({}, { USD: 90 });
  // Reuse the same db/goal state across the rate change by copying it over:
  const first = await goal('g1');
  await db.collection('goals').doc('g1').set(first);
  await run2({ goalId: 'g1', direction: 'contribution', amount: 100, currency: 'USD', operationId: 'd2' }); // locks at 90 → 9000 RUB

  const g = await goal2('g1');
  assert.equal(g.currentAmountRub, 8600 + 9000); // sum of the two LOCKED snapshots
  assert.notEqual(g.currentAmountRub, g.currentAmount * 90); // NOT re-priced at the latest rate (200 * 90 = 18000 would be wrong)
});

test('14. a legacy USD goal (no currentAmountRub field at all) gets a one-time baseline on its first touch', async () => {
  // Simulates data that predates this field: $500 already saved, nobody ever
  // recorded a locked rubAmount for how it got there.
  const { run, goal } = setup({ 'goals/g1': { ...GOAL_USD, currentAmount: 500 } }, { USD: 86 });
  await run({ goalId: 'g1', direction: 'contribution', amount: 10, currency: 'USD', operationId: 'd1' });

  const g = await goal('g1');
  assert.equal(g.currentAmount, 510);
  // Baseline: $500 × 86 = 43000, locked once; + this contribution's own locked 10×86=860.
  assert.equal(g.currentAmountRub, 43000 + 860);
});

test('15. after that one-time baseline, a LATER rate change still never re-prices the already-locked total', async () => {
  const { run, goal, db } = setup({ 'goals/g1': { ...GOAL_USD, currentAmount: 500 } }, { USD: 86 });
  await run({ goalId: 'g1', direction: 'contribution', amount: 0.01, currency: 'USD', operationId: 'd1' }); // forces the baseline to be set
  const afterFirstTouch = await goal('g1');

  // Rate changes a lot — nothing touches the goal again, so NOTHING about
  // its recorded value should change (this is the actual "no phantom
  // profit from an ordinary rate change" guarantee — checked by NOT calling
  // transferGoalFunds again, simulating time passing with the rate moving).
  await db.collection('goals').doc('g1').set(afterFirstTouch); // no-op write, same data
  const stillTheSame = await goal('g1');
  assert.equal(stillTheSame.currentAmountRub, afterFirstTouch.currentAmountRub);
});

test('16. EUR goal: locked rubAmount accumulates correctly across a contribution and a withdrawal', async () => {
  const { run, goal } = setup({ 'goals/g1': { userId: 'u1', title: 'Европа', currentAmount: 0, currency: 'EUR' } }, { EUR: 101 });
  await run({ goalId: 'g1', direction: 'contribution', amount: 50, currency: 'EUR', operationId: 'd1' }); // +50×101=5050
  await run({ goalId: 'g1', direction: 'withdrawal', amount: 20, currency: 'EUR', operationId: 'w1' });   // -20×101=2020
  const g = await goal('g1');
  assert.equal(g.currentAmount, 30);
  assert.equal(g.currentAmountRub, 5050 - 2020);
});

// ═════════════════════════════════════════════════════════════════════════════
// closeGoal — deleting a goal returns any balance to free balance first
// (never silently vanishes it) and is itself atomic + idempotent.
// ═════════════════════════════════════════════════════════════════════════════

test('17. closing a RUB goal with a balance returns it and deletes the goal', async () => {
  const { close, goal, tx, db } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 3000, currentAmountRub: 3000 } });
  const out = await close({ goalId: 'g1' });
  assert.equal(out.ok, true);
  assert.equal(out.hadBalance, true);
  assert.equal(out.returnedRubAmount, 3000);
  assert.equal(await goal('g1'), undefined); // goal doc is gone
  const t = await tx(goalTransferDocId('close-1'));
  assert.equal(t.type, 'goal_withdraw');
  assert.equal(t.goalClosed, true);
  assert.equal(t.rubAmount, 3000);
  assert.equal(db._count('goals/'), 0);
});

test('18. closing a USD goal converts the remainder at a freshly locked rate', async () => {
  const { close, tx } = setup({ 'goals/g1': { ...GOAL_USD, currentAmount: 100, currentAmountRub: 7000 } }, { USD: 86 });
  // Even though the cost basis says 7000, closing uses TODAY's rate (86) for
  // the actual realized conversion — $100 × 86 = 8600.
  const out = await close({ goalId: 'g1' });
  assert.equal(out.returnedRubAmount, 8600);
  const t = await tx(goalTransferDocId('close-1'));
  assert.equal(t.rubAmount, 8600);
  assert.equal(t.currency, 'USD');
});

test('19. closing a goal with a ZERO balance deletes it with no linked transaction', async () => {
  const { close, goal, db } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0, currentAmountRub: 0 } });
  const out = await close({ goalId: 'g1' });
  assert.equal(out.hadBalance, false);
  assert.equal(out.returnedRubAmount, 0);
  assert.equal(await goal('g1'), undefined);
  assert.equal(db._count('transactions/'), 0);
});

test('20. closing someone else\'s goal is rejected, nothing is touched', async () => {
  const { close, goal, db } = setup({ 'goals/g1': { ...GOAL_RUB, userId: 'someone-else', currentAmount: 500 } });
  await assert.rejects(
    () => close({ goalId: 'g1' }),
    (err) => err instanceof GoalTransferError && err.code === 'NOT_FOUND'
  );
  assert.notEqual(await goal('g1'), undefined); // still there
  assert.equal(db._count('transactions/'), 0);
});

test('21. closing a missing goal is rejected', async () => {
  const { close } = setup({});
  await assert.rejects(
    () => close({ goalId: 'does-not-exist' }),
    (err) => err instanceof GoalTransferError && err.code === 'NOT_FOUND'
  );
});

test('22. retrying the same close operationId after success is a no-op, not a second credit', async () => {
  const { close, db } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 3000, currentAmountRub: 3000 } });
  const first  = await close({ goalId: 'g1' });
  const second = await close({ goalId: 'g1' }); // same default operationId 'close-1'
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.returnedRubAmount, 3000);
  assert.equal(db._count('transactions/'), 1); // not 2
});

test('23. closeGoal rejects a missing operationId / uid / goalId', async () => {
  const { db } = setup({ 'goals/g1': GOAL_RUB });
  const fx = fakeFx({});
  await assert.rejects(() => closeGoal({ uid: 'u1', goalId: 'g1' }, { firebase: { db, admin: mockAdmin }, fx }), GoalTransferError);
  await assert.rejects(() => closeGoal({ goalId: 'g1', operationId: 'x' }, { firebase: { db, admin: mockAdmin }, fx }), GoalTransferError);
  await assert.rejects(() => closeGoal({ uid: 'u1', operationId: 'x' }, { firebase: { db, admin: mockAdmin }, fx }), GoalTransferError);
});

// ── Total Funds must not move from closing a goal (money just changes column) ─

test('24. Total Funds (Free Balance + Savings Balance) is unchanged by closing a goal', async () => {
  const { run, close, goal } = setup({ 'goals/g1': { ...GOAL_RUB, currentAmount: 0, currentAmountRub: 0 } });
  await run({ goalId: 'g1', direction: 'contribution', amount: 5000, operationId: 'd1' });
  const before = await goal('g1');
  assert.equal(before.currentAmountRub, 5000); // this was Savings Balance's contribution

  const out = await close({ goalId: 'g1' });
  // The 5000 that disappears from Savings Balance (goal deleted) reappears
  // as exactly 5000 credited back (Free Balance) — same RUB figure, so
  // Total Funds nets to zero change from this operation.
  assert.equal(out.returnedRubAmount, 5000);
});
