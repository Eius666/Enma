'use strict';

// ── Goal transfer service — the ONLY authoritative write path for moving
// money between a user's free balance and a savings goal ──────────────────
//
// Used by every entry point that can deposit/withdraw a goal (Web UI's
// GoalsList → /api/ai/goalAdjust, and Telegram/AI tool-calling's
// deposit_to_goal / withdraw_from_goal). Neither of those may touch
// goal.currentAmount or write a `transactions` doc on their own — see the
// ENMA goal↔finance integration pre-deploy review for the audit that found
// two independent, non-atomic, non-idempotent implementations before this.
//
// Contract:
//   - Goal ownership is verified against the VERIFIED uid, never a
//     client-supplied one.
//   - amount is the operation's own amount, in `currency` (explicit →
//     user.currency → RUB — same precedence as createFinancialTransaction).
//   - The goal's own nominal currency (goal.currency) is never changed by a
//     transfer; if the operation currency differs, the amount is converted
//     into the goal's currency via a RUB pivot, using FX rates LOCKED before
//     the Firestore transaction starts (never call an external provider
//     inside a transaction callback — it can be retried by the SDK).
//   - The linked `transactions` doc and the goal's currentAmount update
//     happen in ONE atomic Firestore transaction. Either both happen or
//     neither does.
//   - `operationId` is REQUIRED and is used verbatim to build the linked
//     transaction's Firestore doc id, so a retry of the exact same logical
//     operation (double click, redelivered Telegram update, retried AI tool
//     call) is detected and returns the original result instead of applying
//     the transfer twice. Callers must derive a STABLE id for the same
//     logical request — never Date.now().

const { HOME_BUDGET_CURRENCY } = require('../config');
const { resolveOperationCurrency } = require('../transactions/financialTransaction');

class GoalTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'GoalTransferError';
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

function fxBlock(snapshot) {
  if (!snapshot) return null;
  const block = {
    rateToRub: snapshot.rateToRub,
    source:    snapshot.source,
    provider:  snapshot.provider,
    capturedAt: snapshot.capturedAt,
    method:    snapshot.method,
    rateSide:  snapshot.rateSide,
    rateDate:  snapshot.rateDate,
  };
  if (snapshot.sampleSize != null)               block.sampleSize = snapshot.sampleSize;
  if (snapshot.requestedDate)                    block.requestedDate = snapshot.requestedDate;
  if (snapshot.rateMatchesRequestedDate != null) block.rateMatchesRequestedDate = snapshot.rateMatchesRequestedDate;
  return block;
}

// A contribution is economically "buying" the goal's currency with free
// balance (same rate side as an expense); a withdrawal is "selling" it back
// (same side as income). This only steers which bank-rate side is quoted —
// it is NOT the transaction `type` stored on the record.
function sideHintFor(direction) {
  return direction === 'withdrawal' ? 'income' : 'expense';
}

// Resolves a locked RUB rate for `currency` — {rateToRub: 1, fx: null} for
// RUB itself (never calls the FX provider for the home currency).
async function lockRateToRub(currency, direction, date, fx) {
  if (currency === HOME_BUDGET_CURRENCY) return { rateToRub: 1, fx: null };
  const snapshot = await fx.getBankRateToRub({ currency, transactionType: sideHintFor(direction), timestamp: date });
  return { rateToRub: snapshot.rateToRub, fx: snapshot };
}

function goalTransferDocId(operationId) {
  return `goalxfer-${operationId}`;
}

/**
 * @param {object} input
 *   uid          verified Firebase UID (never trust a client-supplied one)
 *   goalId       target goal
 *   direction    'contribution' | 'withdrawal'
 *   amount       positive number, in `currency`
 *   currency     optional explicit currency of the operation amount
 *   userCurrency optional override of the user's current input currency
 *                (read from users/{uid}.currency when omitted)
 *   operationId  REQUIRED stable idempotency key for this logical request
 *   source       'web-app' | 'telegram-bot' | ... (free-form, for audit only)
 * @param {object} deps  { firebase: {db, admin}, fx }
 */
async function transferGoalFunds(input, deps = {}) {
  const { db, admin } = deps.firebase || require('../firebaseAdmin');
  const fx = deps.fx || require('../fx');

  const { uid, goalId, direction, amount } = input;

  if (!uid) throw new GoalTransferError('UNAUTHENTICATED', 'uid is required');
  if (!goalId || typeof goalId !== 'string') throw new GoalTransferError('VALIDATION_ERROR', 'goalId is required');
  if (!['contribution', 'withdrawal'].includes(direction)) {
    throw new GoalTransferError('VALIDATION_ERROR', 'direction must be "contribution" or "withdrawal"');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new GoalTransferError('VALIDATION_ERROR', 'amount must be a positive number');
  }
  if (!input.operationId || typeof input.operationId !== 'string') {
    throw new GoalTransferError('VALIDATION_ERROR', 'operationId is required for idempotency');
  }

  const txDocId = goalTransferDocId(input.operationId);
  const txRef   = db.collection('transactions').doc(txDocId);

  // Fast path: already-completed retry. (Also re-checked inside the atomic
  // transaction below to close the race between this read and the write.)
  const existingFast = await txRef.get();
  if (existingFast.exists) {
    const d = existingFast.data();
    return { ok: true, duplicate: true, transactionId: txDocId, goalId, currentAmount: d.goalBalanceAfter ?? null };
  }

  const userCurrency = input.userCurrency !== undefined
    ? input.userCurrency
    : await (async () => {
        try {
          const snap = await db.collection('users').doc(uid).get();
          return snap.exists ? snap.data().currency : null;
        } catch { return null; }
      })();

  const resolvedCurrency = resolveOperationCurrency({ explicit: input.currency, userCurrency });
  const isoDate = new Date().toISOString();

  const goalRef     = db.collection('goals').doc(goalId);
  const goalSnapPre = await goalRef.get();
  if (!goalSnapPre.exists || goalSnapPre.data().userId !== uid) {
    throw new GoalTransferError('NOT_FOUND', 'Goal not found');
  }
  const goalCurrency = goalSnapPre.data().currency || HOME_BUDGET_CURRENCY;

  // ── Lock FX BEFORE the Firestore transaction — never call an external
  // provider inside a callback the SDK may retry (PHASE 5). ──────────────
  const opRate = await lockRateToRub(resolvedCurrency, direction, isoDate, fx);
  const goalRate = goalCurrency === resolvedCurrency
    ? opRate
    : await lockRateToRub(goalCurrency, direction, isoDate, fx);

  const rubAmount = round2(amount * opRate.rateToRub);
  // amount (resolvedCurrency) → goal's own nominal currency, via RUB as a
  // pivot when they differ; identity when they're the same currency.
  const amountInGoalCurrency = resolvedCurrency === goalCurrency
    ? round2(amount)
    : round2(rubAmount / goalRate.rateToRub);

  const txType = direction === 'contribution' ? 'goal_deposit' : 'goal_withdraw';

  const outcome = await db.runTransaction(async (tx) => {
    const [goalSnap, existingTxSnap] = await Promise.all([tx.get(goalRef), tx.get(txRef)]);

    if (existingTxSnap.exists) {
      // Lost the idempotency race to a concurrent identical request.
      const d = existingTxSnap.data();
      return { duplicate: true, currentAmount: d.goalBalanceAfter ?? null };
    }
    if (!goalSnap.exists || goalSnap.data().userId !== uid) {
      throw new GoalTransferError('NOT_FOUND', 'Goal not found');
    }

    const current = Number(goalSnap.data().currentAmount) || 0;
    if (direction === 'withdrawal' && amountInGoalCurrency > current) {
      throw new GoalTransferError(
        'INSUFFICIENT_FUNDS',
        `Insufficient goal balance: have ${current}, requested ${amountInGoalCurrency}`
      );
    }

    const nextAmount = round2(
      direction === 'contribution' ? current + amountInGoalCurrency : current - amountInGoalCurrency
    );

    // ── RUB cost-basis (PHASE: unified FX-neutral valuation) ───────────────
    // currentAmountRub is a running total of LOCKED rubAmounts, maintained
    // atomically alongside currentAmount — it never moves on its own just
    // because today's exchange rate moved (no "phantom profit" from an
    // ordinary FX fluctuation). The only time it's ever derived from a LIVE
    // rate is the lazy, one-time baseline below, for a goal that predates
    // this field (currentAmountRub missing) and already had a nonzero
    // balance nobody ever recorded a locked rubAmount for. After that one
    // conversion, it's locked forever and only moves via real transfers.
    const existingRub = goalSnap.data().currentAmountRub;
    const priorRub = typeof existingRub === 'number' && Number.isFinite(existingRub)
      ? existingRub
      : round2(current * goalRate.rateToRub); // one-time legacy baseline
    const nextAmountRub = round2(direction === 'contribution' ? priorRub + rubAmount : priorRub - rubAmount);

    const title = goalSnap.data().title || '';
    tx.update(goalRef, {
      currentAmount:    nextAmount,
      currentAmountRub: nextAmountRub,
      updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(txRef, {
      userId:       uid,
      schemaVersion: 2,
      type:         txType,
      budgetImpact: false, // goal movement, not income/expense — excluded from those totals by construction
      amount:       round2(amount),
      currency:     resolvedCurrency,
      rubAmount,
      fx:           fxBlock(opRate.fx),
      categoryId:   'cat-goal', // unmapped on purpose — renders via the fallback color path, same as before this service existed
      goalId,
      goalTitleSnapshot:   title,
      goalCurrency,
      amountInGoalCurrency,
      goalBalanceAfter:    nextAmount,
      operationId:  input.operationId,
      description:  direction === 'contribution' ? `Накопления: ${title}` : `Снятие из накоплений: ${title}`,
      date:         isoDate,
      source:       input.source || 'web-app',
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    return { duplicate: false, currentAmount: nextAmount };
  });

  return {
    ok: true,
    duplicate: outcome.duplicate,
    transactionId: txDocId,
    goalId,
    currentAmount: outcome.currentAmount,
  };
}

/**
 * Deletes a goal, returning any remaining balance to free balance FIRST —
 * never just vanishing it. (UX: "Вернуть накопления на свободный баланс"
 * instead of silently deleting the goal along with its money.)
 *
 * The closing withdrawal settles at the goal's own currentAmountRub cost
 * basis, NOT a freshly fetched market rate — see the comment at its call
 * site below for the full reasoning. In short: Savings Balance already
 * counts this goal via currentAmountRub; crediting back anything other
 * than that exact figure would make
 *   Free Balance + Savings Balance == Total Funds
 * momentarily false at the instant of closing, by exactly however far the
 * market rate drifted since the goal was last touched — reintroducing, at
 * the moment of deletion, precisely the "phantom" FX-driven change the
 * unified valuation (currentAmountRub) exists to prevent everywhere else.
 * A live rate is only ever fetched here for a goal that has NEVER been
 * touched since currentAmountRub existed (no cost basis to settle at yet)
 * — a one-time, unavoidable first pricing, not a recurring fluctuation.
 *
 * Idempotent the same way as transferGoalFunds: operationId is required,
 * and a retry after a successful close returns the same result rather than
 * erroring — "the goal is already gone" is success for a delete, not a
 * failure, as long as it's THIS operation that closed it (never treats an
 * unrelated NOT_FOUND, e.g. a typo'd goalId, as success).
 *
 * @param {object} input  { uid, goalId, operationId, source }
 * @param {object} deps   { firebase: {db, admin}, fx }
 */
async function closeGoal(input, deps = {}) {
  const { db, admin } = deps.firebase || require('../firebaseAdmin');
  const fx = deps.fx || require('../fx');

  const { uid, goalId } = input;
  if (!uid) throw new GoalTransferError('UNAUTHENTICATED', 'uid is required');
  if (!goalId || typeof goalId !== 'string') throw new GoalTransferError('VALIDATION_ERROR', 'goalId is required');
  if (!input.operationId || typeof input.operationId !== 'string') {
    throw new GoalTransferError('VALIDATION_ERROR', 'operationId is required for idempotency');
  }

  const txDocId = goalTransferDocId(input.operationId);
  const txRef   = db.collection('transactions').doc(txDocId);
  const goalRef = db.collection('goals').doc(goalId);

  // Fast path: this exact close already happened.
  const existingFast = await txRef.get();
  if (existingFast.exists) {
    const d = existingFast.data();
    return { ok: true, duplicate: true, goalId, returnedRubAmount: d.rubAmount ?? 0, hadBalance: (d.rubAmount ?? 0) > 0 };
  }

  const goalSnapPre = await goalRef.get();
  if (!goalSnapPre.exists || goalSnapPre.data().userId !== uid) {
    throw new GoalTransferError('NOT_FOUND', 'Goal not found');
  }
  const goalData     = goalSnapPre.data();
  const goalCurrency = goalData.currency || HOME_BUDGET_CURRENCY;
  const title        = goalData.title || '';
  const isoDate      = new Date().toISOString();

  // Nothing saved — nothing to return, just delete. No linked transaction
  // needed (there would be nothing for it to record).
  if (!(Number(goalData.currentAmount) > 0)) {
    await db.runTransaction(async (tx) => {
      const [goalSnap, existingTxSnap] = await Promise.all([tx.get(goalRef), tx.get(txRef)]);
      if (existingTxSnap.exists) return;
      if (!goalSnap.exists || goalSnap.data().userId !== uid) return; // already gone
      tx.delete(goalRef);
    });
    return { ok: true, duplicate: false, goalId, returnedRubAmount: 0, hadBalance: false };
  }

  // ── Settle at cost basis, not a fresh market rate ───────────────────────
  // This is the critical choice for the Total Funds invariant: Savings
  // Balance already counts this goal via currentAmountRub (the sum of every
  // LOCKED rubAmount that ever moved into/out of it). If closing credited
  // free balance at TODAY's rate instead, Total Funds would jump by exactly
  // however far the rate drifted since the goal was last touched — the
  // very "phantom" effect the unified valuation was built to eliminate,
  // just relocated to the moment of deletion instead of every render.
  // Crediting back currentAmountRub exactly keeps
  //   Free Balance + Savings Balance == Total Funds
  // true with NO dependency on today's market rate, for any goal that has
  // been touched at least once since currentAmountRub was introduced.
  //
  // The ONE case that still needs a live rate: a goal that has NEVER been
  // touched since this field existed (no currentAmountRub at all) and is
  // being closed directly, with no prior transfer to have captured a
  // baseline. That first conversion has to happen at SOME rate — this is
  // it, and it only ever happens once, same as transferGoalFunds's own
  // lazy baseline capture; it is not a recurring "phantom" fluctuation,
  // it is the one real, unavoidable first pricing of a never-priced
  // balance.
  const needsLiveRate = typeof goalData.currentAmountRub !== 'number' || !Number.isFinite(goalData.currentAmountRub);
  const legacyRate = needsLiveRate ? await lockRateToRub(goalCurrency, 'withdrawal', isoDate, fx) : null;

  const result = await db.runTransaction(async (tx) => {
    const [goalSnap, existingTxSnap] = await Promise.all([tx.get(goalRef), tx.get(txRef)]);

    if (existingTxSnap.exists) {
      const d = existingTxSnap.data();
      return { duplicate: true, returnedRubAmount: d.rubAmount ?? 0, hadBalance: (d.rubAmount ?? 0) > 0 };
    }
    if (!goalSnap.exists || goalSnap.data().userId !== uid) {
      // Already closed by someone/something else between our pre-read and
      // now, with no matching operationId doc — treat as a no-op success
      // rather than erroring a delete that already achieved its goal.
      return { duplicate: false, returnedRubAmount: 0, hadBalance: false };
    }

    const freshData   = goalSnap.data();
    const freshAmount  = Number(freshData.currentAmount) || 0;
    if (freshAmount <= 0) {
      tx.delete(goalRef);
      return { duplicate: false, returnedRubAmount: 0, hadBalance: false };
    }

    const freshRubRaw = freshData.currentAmountRub;
    const hasCostBasis = typeof freshRubRaw === 'number' && Number.isFinite(freshRubRaw);
    // Prefer the FRESH cost basis read inside the transaction over the
    // pre-transaction legacyRate check — a concurrent transfer between our
    // pre-read and now may have already established one.
    const rubAmount = hasCostBasis ? freshRubRaw : round2(freshAmount * legacyRate.rateToRub);

    // RUB-denominated goals never had FX in the first place (rateToRub is
    // always 1) — fx stays null, same convention as every RUB transaction
    // elsewhere. A foreign-currency goal settled at cost basis gets a
    // synthetic snapshot carrying the EFFECTIVE blended rate implied by
    // that cost basis, clearly labeled so it's never confused with a real
    // bank quote; one settled via the legacy one-time baseline gets the
    // genuine locked quote instead.
    let fxRecord = null;
    if (goalCurrency !== HOME_BUDGET_CURRENCY) {
      fxRecord = hasCostBasis
        ? fxBlock({
            rateToRub:  round2(rubAmount / freshAmount),
            source:     'cost_basis_settlement',
            provider:   'enma-internal',
            capturedAt: isoDate,
            method:     'locked_cost_basis',
            rateSide:   'cost_basis', // not a real bank_buys/bank_sells quote — fxBlock requires the key present
            rateDate:   isoDate.slice(0, 10),
          })
        : fxBlock(legacyRate.fx);
    }

    tx.delete(goalRef);
    tx.set(txRef, {
      userId:       uid,
      schemaVersion: 2,
      type:         'goal_withdraw',
      budgetImpact: false,
      amount:       round2(freshAmount),
      currency:     goalCurrency,
      rubAmount,
      fx:           fxRecord,
      categoryId:   'cat-goal',
      goalId,
      goalTitleSnapshot:    title,
      goalCurrency,
      amountInGoalCurrency: round2(freshAmount),
      goalBalanceAfter:     0,
      goalClosed:   true, // this goal no longer exists — distinguishes a closing return from an ordinary withdrawal
      operationId:  input.operationId,
      description:  `Закрытие цели: возврат остатка — ${title}`,
      date:         isoDate,
      source:       input.source || 'web-app',
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    return { duplicate: false, returnedRubAmount: rubAmount, hadBalance: true };
  });

  return { ok: true, duplicate: result.duplicate, goalId, returnedRubAmount: result.returnedRubAmount, hadBalance: result.hadBalance };
}

module.exports = { transferGoalFunds, closeGoal, goalTransferDocId, GoalTransferError };
