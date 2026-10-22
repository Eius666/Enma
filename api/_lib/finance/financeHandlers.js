'use strict';

// Finance actions of POST /api/ai/<action>: transaction edits, the finance
// PDF report and savings goals. Built by the api/ai router with its
// dependencies injected (see api/ai/[action].js).

const MAX_GOAL_AMOUNT = 1_000_000_000;
const isPosNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_GOAL_AMOUNT;
const round2 = (n) => Math.round(n * 100) / 100;

function createFinanceHandlers(ctx) {
  const {
    db, admin, requireAuth, HOME_BUDGET_CURRENCY,
    buildTransactionUpdate, TransactionValidationError, FxUnavailableError,
    getActivePlan, checkAndIncrementAiUsage, AI_LIMITS, exportFinancePdf,
  } = ctx;

  // Transaction edit — the only path that may change money fields of an
  // existing transaction. Semantics live in buildTransactionUpdate.
  async function handleTransactionUpdate(req, res) {
    const verifiedUid = await requireAuth(req, res);
    if (!verifiedUid) return;

    const { id, patch } = req.body ?? {};
    if (!id || typeof id !== 'string' || !patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'Missing id or patch' });
    }

    try {
      const ref  = db.collection('transactions').doc(id);
      const snap = await ref.get();
      if (!snap.exists || snap.data().userId !== verifiedUid) {
        return res.status(404).json({ error: 'Transaction not found' });
      }
      const userSnap = await db.collection('users').doc(verifiedUid).get();
      const userCurrency = userSnap.exists ? userSnap.data().currency : null;

      const updates = await buildTransactionUpdate({ existing: snap.data(), patch, userCurrency });
      if (Object.keys(updates).length) {
        await ref.update({ ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      const merged = { ...snap.data(), ...updates };
      return res.status(200).json({
        ok: true, id,
        transaction: { amount: merged.amount, currency: merged.currency, rubAmount: merged.rubAmount, fx: merged.fx || null, schemaVersion: merged.schemaVersion },
      });
    } catch (err) {
      if (err instanceof FxUnavailableError) {
        return res.status(503).json({ error: 'FX unavailable', code: 'fx_unavailable', currency: err.currency });
      }
      if (err instanceof TransactionValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error('[ai/transactionUpdate] error:', err.message);
      return res.status(500).json({ error: 'Failed to update transaction' });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Finance PDF export — the Web counterpart of tools.js's export_finance_pdf
  // Telegram tool. Both call the SAME api/_lib/pdf/exportFinancePdf.js
  // orchestrator (PHASE 7: one shared generator for both surfaces).
  //
  // There is no conversational "Web AI chat" surface in this codebase today
  // (the api/ai router has no 'chat' action, and chatWithTools/
  // TOOL_DEFINITIONS are only ever imported by api/telegram/webhook.js) —
  // so this is a direct, authenticated REST action a Web UI button calls,
  // not a natural-language tool call. It still delivers the exact same PDF.
  //
  // Delivery is the PDF bytes themselves, streamed back as THIS request's
  // response body (Content-Type: application/pdf) — never written to any
  // bucket, never a signed URL. There is no file to secure after the fact
  // because there is no file after the fact: it only ever exists in memory
  // for the duration of one already-authenticated request, which is a
  // stronger guarantee than a short-lived link (nothing to leak, expire, or
  // clean up later).
  // ───────────────────────────────────────────────────────────────────────────

  async function handleExportFinancePdf(req, res) {
    const verifiedUid = await requireAuth(req, res);
    if (!verifiedUid) return;

    const plan = await getActivePlan(verifiedUid);
    const usage = await checkAndIncrementAiUsage(verifiedUid, AI_LIMITS[plan] || AI_LIMITS.free, 'pdf');
    if (!usage.allowed) {
      return res.status(429).json({
        error: plan === 'premium'
          ? 'Лимит PDF-отчётов на этот месяц исчерпан.'
          : 'PDF-отчёты доступны на тарифе Premium.',
        code: 'pdf_limit', plan, used: usage.used, limit: usage.limit,
      });
    }

    const body = req.body ?? {};
    const result = await exportFinancePdf({
      uid: verifiedUid,
      period: body.period,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      includeTransactions: body.includeTransactions,
      includeCategories: body.includeCategories,
      includeAccounts: body.includeAccounts,
      includeGoals: body.includeGoals,
      includeCharts: body.includeCharts,
    });

    if (!result.ok) {
      const status = result.code === 'INVALID_PERIOD' || result.code === 'INVALID_DATE_RANGE' ? 400
        : result.code === 'TOO_MANY_TRANSACTIONS' ? 413
        : result.code === 'DATA_UNAVAILABLE' || result.code === 'FX_UNAVAILABLE' ? 503
        : 500;
      return res.status(status).json({ error: result.error, code: result.code });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', String(result.buffer.length));
    res.setHeader('Cache-Control', 'no-store'); // sensitive financial data — never cached by any intermediary
    return res.status(200).send(result.buffer);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Savings goals — server-owned writes (clients only read via Firestore rules).
  // Web-created goals are in the budget currency (RUB); goals created elsewhere
  // (Telegram) keep their own `currency`, and deposits are always in that
  // goal's currency, so no FX is ever involved.
  // ───────────────────────────────────────────────────────────────────────────

  async function handleGoalCreate(req, res) {
    const uid = await requireAuth(req, res);
    if (!uid) return;
    const { title, targetAmount, deadline } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim() || title.length > 120) {
      return res.status(400).json({ error: 'Invalid title', code: 'VALIDATION_ERROR' });
    }
    if (!isPosNum(targetAmount)) {
      return res.status(400).json({ error: 'Invalid targetAmount', code: 'VALIDATION_ERROR' });
    }
    if (deadline != null && deadline !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(deadline))) {
      return res.status(400).json({ error: 'Invalid deadline', code: 'VALIDATION_ERROR' });
    }
    try {
      const ref = db.collection('goals').doc();
      await ref.set({
        userId: uid,
        title: title.trim(),
        targetAmount: round2(targetAmount),
        currentAmount: 0,
        currentAmountRub: 0, // RUB cost-basis, maintained by goalTransfer.js — 0 is exact, no FX needed for a brand-new goal
        currency: HOME_BUDGET_CURRENCY,
        deadline: deadline ? String(deadline) : null,
        category: null,
        source: 'web-app',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, id: ref.id });
    } catch (err) {
      console.error('[ai/goalCreate] error:', err.message);
      return res.status(500).json({ error: 'Failed to create goal' });
    }
  }

  // direction: 'deposit' adds to the goal (and debits free balance), 'withdraw'
  // subtracts (and credits free balance back) — never below 0. Delegates to
  // transferGoalFunds, the single authoritative write path shared with
  // Telegram/AI tool-calling (api/_lib/tools.js's deposit_to_goal /
  // withdraw_from_goal) — see api/_lib/finance/goalTransfer.js.
  async function handleGoalAdjust(req, res) {
    const uid = await requireAuth(req, res);
    if (!uid) return;
    const { id, amount, direction, operationId } = req.body ?? {};
    if (typeof id !== 'string' || !id || !isPosNum(amount) || !['deposit', 'withdraw'].includes(direction)) {
      return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR' });
    }
    if (typeof operationId !== 'string' || !operationId.trim()) {
      return res.status(400).json({ error: 'Missing operationId', code: 'VALIDATION_ERROR' });
    }

    const { transferGoalFunds, GoalTransferError } = require('./goalTransfer');
    try {
      const out = await transferGoalFunds({
        uid,
        goalId: id,
        direction: direction === 'deposit' ? 'contribution' : 'withdrawal',
        amount,
        operationId: String(operationId).trim().slice(0, 200),
        source: 'web-app',
      });
      return res.status(200).json({ ok: true, id, currentAmount: out.currentAmount, duplicate: out.duplicate });
    } catch (err) {
      if (err instanceof GoalTransferError) {
        if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Goal not found' });
        if (err.code === 'INSUFFICIENT_FUNDS') return res.status(400).json({ error: err.message, code: 'INSUFFICIENT' });
        if (err.code === 'VALIDATION_ERROR') return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }
      console.error('[ai/goalAdjust] error:', err.message);
      return res.status(500).json({ error: 'Failed to update goal' });
    }
  }

  // Deleting a goal returns any remaining balance to free balance FIRST — see
  // api/_lib/finance/goalTransfer.js's closeGoal. Never just vanishes the
  // money (UX: "Вернуть накопления на свободный баланс", not a silent delete).
  async function handleGoalDelete(req, res) {
    const uid = await requireAuth(req, res);
    if (!uid) return;
    const { id, operationId } = req.body ?? {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR' });
    if (typeof operationId !== 'string' || !operationId.trim()) {
      return res.status(400).json({ error: 'Missing operationId', code: 'VALIDATION_ERROR' });
    }

    const { closeGoal, GoalTransferError } = require('./goalTransfer');
    try {
      const out = await closeGoal({ uid, goalId: id, operationId: String(operationId).trim().slice(0, 200), source: 'web-app' });
      return res.status(200).json({ ok: true, id, returnedRubAmount: out.returnedRubAmount, hadBalance: out.hadBalance, duplicate: out.duplicate });
    } catch (err) {
      if (err instanceof GoalTransferError && err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Goal not found' });
      console.error('[ai/goalDelete] error:', err.message);
      return res.status(500).json({ error: 'Failed to delete goal' });
    }
  }

  return { handleTransactionUpdate, handleExportFinancePdf, handleGoalCreate, handleGoalAdjust, handleGoalDelete };
}

module.exports = { createFinanceHandlers };
