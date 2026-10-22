'use strict';

// Savings-goal tools of the Telegram assistant: create_goal, deposit_to_goal,
// withdraw_from_goal, list_goals, delete_goal. Built by api/_lib/tools.js
// with its dependencies injected.

function progressBar(current, target, width = 10) {
  const pct    = Math.min(current / (target || 1), 1);
  const filled = Math.round(pct * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function createGoalTools(ctx) {
  const { db, admin, createId, CURRENCY_SYMBOLS, transferGoalFunds, closeGoal, GoalTransferError } = ctx;

  async function createGoal(args, userId, currency) {
    const { title, targetAmount, deadline, category } = args;
    // Explicit currency named by the user ("Хочу накопить $20 000") always wins
    // over the user's current display currency — never silently reinterpret a
    // named amount into a different currency.
    const goalCurrency = (args.currency && CURRENCY_SYMBOLS[args.currency]) ? args.currency : currency;
    const sym = CURRENCY_SYMBOLS[goalCurrency] || goalCurrency;
    const id  = createId();

    await db.collection('goals').doc(id).set({
      userId,
      title,
      targetAmount,
      currentAmount: 0,
      currentAmountRub: 0, // RUB cost-basis, maintained by goalTransfer.js — 0 is exact, no FX needed for a brand-new goal
      currency: goalCurrency,
      deadline:  deadline  || null,
      category:  category  || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let motivation = '';
    if (deadline) {
      const months = Math.ceil((new Date(deadline) - new Date()) / (1000 * 60 * 60 * 24 * 30));
      if (months > 0) {
        const monthly = Math.ceil(targetAmount / months);
        motivation = `\n\nПри откладывании <b>${monthly} ${sym}/мес</b> достигнешь цели за ${months} мес.`;
      }
    }

    return {
      ok: true,
      message: `🎯 Цель создана: <b>${title}</b>\nЦелевая сумма: ${targetAmount} ${sym}${motivation}\nID: <code>${id}</code>`,
    };
  }

  // Both deposit_to_goal and withdraw_from_goal delegate to transferGoalFunds
  // — the single authoritative write path shared with the Web UI's goalAdjust
  // (api/_lib/finance/financeHandlers.js) — see api/_lib/finance/goalTransfer.js. Neither
  // function touches goals/transactions directly any more: the old code did
  // two independent, non-atomic Firestore writes with no FX/rubAmount and no
  // idempotency protection against a redelivered Telegram update.
  //
  // operationId is derived from (chatId, messageId, goalId, direction) — all
  // of them stable across a webhook redelivery of the SAME inbound update, so
  // a retry resolves to the exact same logical operation. When messageId is
  // unavailable (defensive fallback only — every real call site passes it),
  // a per-call unique value is used so the user is never blocked from acting,
  // at the cost of only protecting against double-click/network-retry within
  // THIS call, not across a Telegram redelivery of the original message.
  function goalOperationId(chatId, messageId, goalId, direction) {
    const stableMessageId = messageId ?? `nomsg-${createId()}`;
    return `tg-${chatId}-${stableMessageId}-${goalId}-${direction}`;
  }

  async function depositToGoal(args, userId, chatId, currency, messageId) {
    const { goalId, amount } = args;
    const sym = CURRENCY_SYMBOLS[currency] || currency;

    let result;
    try {
      result = await transferGoalFunds({
        uid: userId,
        goalId,
        direction: 'contribution',
        amount,
        currency,
        operationId: goalOperationId(chatId, messageId, goalId, 'contribution'),
        source: 'telegram-bot',
      });
    } catch (err) {
      if (err instanceof GoalTransferError && err.code === 'NOT_FOUND') return { ok: false, error: 'Цель не найдена' };
      if (err instanceof GoalTransferError) return { ok: false, error: err.message };
      throw err;
    }

    const goalSnap  = await db.collection('goals').doc(goalId).get();
    const goal      = goalSnap.data();
    const newAmount = result.currentAmount;
    const pct      = Math.min(Math.round(newAmount / goal.targetAmount * 100), 100);
    const bar      = progressBar(newAmount, goal.targetAmount);
    const congrats = pct >= 100 ? '\n\n🎉 Цель достигнута! Поздравляем!' : '';
    return {
      ok: true,
      message: `💰 Пополнение: +${amount} ${sym}\n🎯 <b>${goal.title}</b>\n${bar} ${pct}%\n${newAmount} / ${goal.targetAmount} ${sym}${congrats}`,
    };
  }

  async function withdrawFromGoal(args, userId, chatId, currency, messageId) {
    const { goalId, amount } = args;
    const sym = CURRENCY_SYMBOLS[currency] || currency;

    let result;
    try {
      result = await transferGoalFunds({
        uid: userId,
        goalId,
        direction: 'withdrawal',
        amount,
        currency,
        operationId: goalOperationId(chatId, messageId, goalId, 'withdrawal'),
        source: 'telegram-bot',
      });
    } catch (err) {
      if (err instanceof GoalTransferError && err.code === 'NOT_FOUND') return { ok: false, error: 'Цель не найдена' };
      if (err instanceof GoalTransferError && err.code === 'INSUFFICIENT_FUNDS') {
        const current = (await db.collection('goals').doc(goalId).get()).data()?.currentAmount ?? 0;
        return { ok: false, error: `Недостаточно средств. Накоплено: ${current} ${sym}` };
      }
      if (err instanceof GoalTransferError) return { ok: false, error: err.message };
      throw err;
    }

    const goalSnap  = await db.collection('goals').doc(goalId).get();
    const goal      = goalSnap.data();
    const newAmount = result.currentAmount;
    const pct = Math.round(newAmount / goal.targetAmount * 100);
    const bar = progressBar(newAmount, goal.targetAmount);
    return {
      ok: true,
      message: `📉 Снятие: -${amount} ${sym}\n🎯 <b>${goal.title}</b>\n${bar} ${pct}%\n${newAmount} / ${goal.targetAmount} ${sym}`,
    };
  }

  async function listGoals(userId, currency) {
    const sym  = CURRENCY_SYMBOLS[currency] || currency;
    const snap = await db.collection('goals')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    if (snap.empty) return { ok: true, message: 'У тебя нет целей накопления.\n\nСоздай первую: «Хочу накопить на отпуск 50 000»' };

    const lines = snap.docs.map(d => {
      const g    = d.data();
      const cur  = g.currentAmount || 0;
      const pct  = Math.min(Math.round(cur / g.targetAmount * 100), 100);
      const bar  = progressBar(cur, g.targetAmount);
      const dl   = g.deadline
        ? `\n📅 ${new Date(g.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : '';
      return `🎯 <b>${g.title}</b> — ${cur} / ${g.targetAmount} ${sym} (${pct}%)\n${bar}${dl}\nID: <code>${d.id}</code>`;
    });
    return { ok: true, message: `🎯 <b>Цели накопления:</b>\n\n${lines.join('\n\n')}` };
  }

  // Returns any remaining balance to free balance BEFORE deleting — see
  // api/_lib/finance/goalTransfer.js's closeGoal. Never silently vanishes it.
  async function deleteGoal(args, userId, chatId, messageId) {
    const { goalId } = args;
    const snap = await db.collection('goals').doc(goalId).get();
    if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Цель не найдена' };
    const title = snap.data().title;

    let out;
    try {
      out = await closeGoal({
        uid: userId,
        goalId,
        operationId: goalOperationId(chatId, messageId, goalId, 'close'),
        source: 'telegram-bot',
      });
    } catch (err) {
      if (err instanceof GoalTransferError) return { ok: false, error: err.message };
      throw err;
    }

    if (!out.hadBalance) return { ok: true, message: `✅ Цель «${title}» удалена.` };
    return {
      ok: true,
      message: `✅ Цель «${title}» удалена.\n💰 Возвращено на свободный баланс: ${out.returnedRubAmount} ₽`,
    };
  }

  return { createGoal, depositToGoal, withdrawFromGoal, listGoals, deleteGoal };
}

module.exports = { createGoalTools, progressBar };
