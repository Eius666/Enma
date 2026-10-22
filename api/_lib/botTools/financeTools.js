'use strict';

// Finance tools of the Telegram assistant: create_transaction,
// query_transactions, get_finance_stats, export_finance_pdf. Built by
// api/_lib/tools.js with its dependencies injected, so this module holds no
// Firebase or module state of its own.

function autoCategorize(description) {
  const lower = (description || '').toLowerCase();
  const rules = {
    food:          ['кофе', 'еда', 'ресторан', 'cafe', 'food', 'пицца', 'суши', 'бургер', 'обед', 'ужин', 'завтрак', 'продукт', 'маркет', 'доставка', 'перекус', 'фастфуд'],
    transport:     ['такси', 'метро', 'бензин', 'парковк', 'uber', 'bolt', 'yandex go', 'транспорт', 'билет', 'автобус', 'электричк'],
    entertainment: ['кино', 'фильм', 'игра', 'нетфликс', 'netflix', 'spotify', 'подписк', 'развлеч', 'концерт', 'театр'],
    shopping:      ['одежд', 'обувь', 'магазин', 'amazon', 'ozon', 'wildberries', 'покупк', 'шопинг'],
    bills:         ['аренд', 'коммунал', 'свет', 'интернет', 'телефон', 'хранени'],
    health:        ['аптек', 'врач', 'больниц', 'спорт', 'зал', 'фитнес', 'лекарств', 'витамин'],
    study:         ['курс', 'книг', 'обучен', 'удем', 'skillbox', 'учёба'],
  };
  for (const [cat, keywords] of Object.entries(rules)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

const TELEGRAM_MAX_DOCUMENT_BYTES = 45 * 1024 * 1024; // Telegram's own bot-upload cap is 50MB; stay under it with margin.

function createFinanceTools(ctx) {
  const {
    db, admin, txRepo, getExchangeRates, normalizeTransactionsCurrency, needsFx,
    HOME_BUDGET_CURRENCY, CURRENCY_SYMBOLS, hasLockedRub, resolveTransactionCurrency,
    createFinancialTransaction, TransactionValidationError, FxUnavailableError,
    getActivePlan, checkAndIncrementAiUsage, AI_LIMITS, exportFinancePdf,
  } = ctx;

  async function createTransaction(args, userId, chatId, userCurrency) {
    const { amount, description, type, bank, goalId } = args;
    const category = args.category || autoCategorize(description);

    let created;
    try {
      // Money fields (currency precedence, rubAmount, FX snapshot) are decided
      // by the shared service — never here.
      created = await createFinancialTransaction({
        uid: userId,
        type, amount,
        currency: args.currency,
        userCurrency,
        description,
        categoryId: `cat-${category}`,
        bank, goalId,
        source: 'telegram-bot',
        extra: { chatId },
      });
    } catch (err) {
      if (err instanceof FxUnavailableError) {
        return { ok: false, error: `Не удалось получить надёжный курс ${args.currency || userCurrency} — операция не сохранена. Попробуйте позже или укажите сумму в рублях.` };
      }
      if (err instanceof TransactionValidationError) return { ok: false, error: err.message };
      throw err;
    }

    const tx = created.transaction;
    if (bank) {
      await db.collection('users').doc(userId).update({
        banks: admin.firestore.FieldValue.arrayUnion(bank),
      }).catch(() => {});
    }

    if (goalId) {
      const goalRef  = db.collection('goals').doc(goalId);
      const goalSnap = await goalRef.get().catch(() => null);
      if (goalSnap?.exists && goalSnap.data().userId === userId) {
        const current = goalSnap.data().currentAmount || 0;
        // Goals are tracked in the budget currency (RUB)
        const delta   = type === 'income' ? tx.rubAmount : -tx.rubAmount;
        await goalRef.update({
          currentAmount: Math.max(0, current + delta),
          updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    }

    const emoji    = type === 'income' ? '💰' : '💸';
    const verb     = type === 'income' ? 'Доход' : 'Расход';
    const sym      = CURRENCY_SYMBOLS[tx.currency] || tx.currency;
    const bankStr  = bank ? ` [${bank}]` : '';
    const approx   = tx.currency !== HOME_BUDGET_CURRENCY
      ? ` (≈ ${Math.round(tx.rubAmount).toLocaleString('ru-RU')} ₽${tx.fx && tx.fx.source !== 'bank_average' && tx.fx.source !== 'bank_quote' ? ', оценочный курс' : ''})`
      : '';
    return { ok: true, message: `${emoji} ${verb}: ${description} — ${tx.amount} ${sym}${approx} [${category}]${bankStr}` };
  }

  async function queryTransactions(args, userId) {
    const { type = 'all', limit = 10, bank } = args || {};

    let txs;
    try {
      txs = await txRepo.getAllTransactions(userId);
    } catch (_) {
      return { ok: true, message: 'Нет транзакций.' };
    }

    txs = txRepo.filterByType(txs, type);
    if (bank) txs = txs.filter(t => t.bank === bank);
    txs = txs.slice(0, Math.min(limit, 20));

    if (!txs.length) return { ok: true, message: 'Нет транзакций.' };

    const lines = txs.map(t => {
      const emoji = t.type === 'income' ? '💰'
        : (t.type === 'goal_deposit' || t.type === 'goal_withdraw') ? '🎯'
        : '💸';
      const bankLabel = t.bank ? ` [${t.bank}]` : '';
      // v2 rows show their real currency (+ locked ₽ value); legacy rows keep
      // the resolver-derived currency.
      const cur = hasLockedRub(t) ? t.currency : (resolveTransactionCurrency(t).currency || HOME_BUDGET_CURRENCY);
      const sym = CURRENCY_SYMBOLS[cur] || cur;
      const rub = hasLockedRub(t) && cur !== HOME_BUDGET_CURRENCY
        ? ` (≈ ${Math.round(t.rubAmount).toLocaleString('ru-RU')} ₽)` : '';
      return `${emoji} ${t.description} — ${t.amount} ${sym}${rub}${bankLabel}`;
    });
    return { ok: true, message: `💳 История:\n${lines.join('\n')}` };
  }

  async function getFinanceStats(args, userId, currency = 'RUB') {
    const { period = 'month' } = args || {};
    const now = new Date();

    let startDate = null;
    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      startDate = new Date(now.getTime() - 7 * 86_400_000);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    // CRITICAL: Single-field filter only — avoids composite index requirement.
    // Use shared repository — single-field filter, no composite index required.
    let allTransactions = [];
    try {
      allTransactions = await txRepo.getAllTransactions(userId);
    } catch (err) {
      console.error('[AI_FINANCE_CONTEXT] balance=FAILED reason=%s', err.code || err.message);
      return { ok: false, error: 'Не удалось загрузить финансовые данные. Попробуй чуть позже.' };
    }

    // Never sum raw amounts across different currencies, and never guess a
    // legacy record's currency as a blanket default — normalizeTransactionsCurrency
    // resolves each one via resolveTransactionCurrency (source + createdAt) and
    // converts it into `currency` ONCE, up front. Fetch FX rates only if a
    // transaction actually needs converting — a RUB-only user (the common
    // case) never triggers a network call and stays correct if the FX API is
    // ever offline.
    const rates = needsFx(allTransactions, currency) ? await getExchangeRates() : null;
    const normalized = normalizeTransactionsCurrency(allTransactions, currency, rates);
    if (!normalized.ok) {
      return { ok: false, error: 'Часть операций в другой валюте, курс обмена сейчас недоступен — точный расчёт баланса невозможен.' };
    }
    allTransactions = normalized.transactions; // every amount below is already in `currency`

    // CRITICAL: actual balance = sum(all income) - sum(all expenses) over all time
    const currentBalance = txRepo.calculateCurrentBalance(allTransactions, currency, rates);

    // USEFUL: period breakdown — isolated in try/catch
    let totalExpense = 0;
    let totalIncome  = 0;
    const categories = {};
    const byBank     = {};
    let periodOk = true;

    try {
      const periodTxs = startDate
        ? allTransactions.filter(t => t.date && new Date(t.date) >= startDate)
        : allTransactions;

      for (const t of periodTxs) {
        const amount = t.amount; // already normalized into `currency` above

        if (t.type === 'expense') {
          totalExpense += amount;
          const cat = (t.categoryId || 'cat-other').replace('cat-', '');
          categories[cat] = (categories[cat] || 0) + amount;
          if (t.bank) {
            if (!byBank[t.bank]) byBank[t.bank] = { income: 0, expense: 0 };
            byBank[t.bank].expense += amount;
          }
        } else if (t.type === 'income') {
          totalIncome += amount;
          if (t.bank) {
            if (!byBank[t.bank]) byBank[t.bank] = { income: 0, expense: 0 };
            byBank[t.bank].income += amount;
          }
        }
      }
    } catch (err) {
      console.error('[AI_FINANCE_CONTEXT] balance=loaded periodBreakdown=FAILED reason=%s', err.message);
      periodOk = false;
    }

    const sym = CURRENCY_SYMBOLS[currency] || currency;
    const balanceSign = currentBalance >= 0 ? '+' : '';

    const lines = [
      `💳 Баланс: ${balanceSign}${currentBalance.toFixed(2)} ${sym}`,
    ];

    if (periodOk) {
      const periodLabel = { today: 'Сегодня', week: 'За неделю', month: 'За месяц', all: 'За всё время' }[period] || 'За всё время';
      const net = totalIncome - totalExpense;
      lines.push(
        `\n📊 ${periodLabel}`,
        `💸 Расходы: ${totalExpense.toFixed(2)} ${sym}`,
        `💰 Доходы:  ${totalIncome.toFixed(2)} ${sym}`,
        `${net >= 0 ? '✅' : '⚠️'} Результат за период: ${net >= 0 ? '+' : ''}${net.toFixed(2)} ${sym}`,
      );

      // OPTIONAL: categories and bank breakdown
      try {
        const catEntries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
        if (catEntries.length) {
          lines.push('', 'По категориям:');
          for (const [cat, amount] of catEntries) {
            lines.push(`  • ${cat}: ${amount.toFixed(2)} ${sym}`);
          }
        }

        const bankEntries = Object.entries(byBank).sort((a, b) => (b[1].expense + b[1].income) - (a[1].expense + a[1].income));
        if (bankEntries.length) {
          lines.push('', 'По банкам:');
          for (const [bk, stats] of bankEntries) {
            const parts = [];
            if (stats.expense > 0) parts.push(`расходы ${stats.expense.toFixed(2)} ${sym}`);
            if (stats.income  > 0) parts.push(`доходы ${stats.income.toFixed(2)} ${sym}`);
            lines.push(`  • ${bk}: ${parts.join(', ')}`);
          }
        }
      } catch (err) {
        console.error('[AI_FINANCE_CONTEXT] balance=loaded periodBreakdown=loaded categories=FAILED reason=%s', err.message);
      }
    }

    return { ok: true, message: lines.join('\n') };
  }

  // ── export_finance_pdf ───────────────────────────────────────────────────────
  // Generates the real PDF (via api/_lib/pdf/exportFinancePdf.js — the SAME
  // orchestrator the Web /api/ai/exportFinancePdf route uses, per PHASE 7:
  // one shared generator for both surfaces) and uploads it directly to
  // Telegram via sendDocument, mirroring generateImage's own sendPhoto
  // upload (botTools/imageTools.js). Never reports success to the chat loop unless Telegram
  // itself confirmed the upload (checked via the response body, not just a
  // non-throwing fetch — a non-2xx Telegram response does not throw).
  //
  // PDF export is premium-only (src/subscription.ts's AI_LIMITS —
  // pdfReports: 0 for free AND pro) — the only ENMA AI feature on Telegram
  // that is actually plan-gated right now, since the general subscription
  // prompt in api/telegram/webhook.js (sendSubscriptionPrompt) exists but is
  // never called from anywhere. Enforcing this one existing, explicit
  // contract rather than leaving PDF export as ungated as everything else.
  async function exportFinancePdfTool(args, userId, chatId, timezone) {
    const plan = await getActivePlan(userId);
    const usage = await checkAndIncrementAiUsage(userId, AI_LIMITS[plan] || AI_LIMITS.free, 'pdf');
    if (!usage.allowed) {
      return {
        ok: false,
        error: plan === 'premium'
          ? `Лимит PDF-отчётов на этот месяц исчерпан (${usage.used}/${usage.limit}). Новый лимит появится в следующем месяце.`
          : 'PDF-отчёты доступны на тарифе Premium. Оформи подписку, чтобы выгружать полный финансовый отчёт в PDF.',
      };
    }

    const result = await exportFinancePdf({
      uid: userId,
      period: args?.period,
      dateFrom: args?.dateFrom,
      dateTo: args?.dateTo,
      includeTransactions: args?.includeTransactions,
      includeCategories: args?.includeCategories,
      includeAccounts: args?.includeAccounts,
      includeGoals: args?.includeGoals,
      includeCharts: args?.includeCharts,
      timezone,
    });

    if (!result.ok) {
      console.error('[export_finance_pdf] generation failed:', result.code, result.error);
      return { ok: false, error: result.error };
    }

    if (result.buffer.length > TELEGRAM_MAX_DOCUMENT_BYTES) {
      return { ok: false, error: 'Отчёт получился слишком большим для отправки в Telegram. Попробуй выбрать более короткий период.' };
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('caption', `📄 Финансовый отчёт — ${result.period.label}`);
    formData.append('document', new Blob([result.buffer], { type: 'application/pdf' }), result.filename);

    let tgResp;
    try {
      tgResp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: formData });
    } catch (err) {
      console.error('[export_finance_pdf] Telegram upload failed:', err.message);
      return { ok: false, error: 'PDF сформирован, но не удалось отправить его в Telegram. Попробуй ещё раз.' };
    }

    const tgData = await tgResp.json().catch(() => null);
    if (!tgResp.ok || !tgData?.ok) {
      console.error('[export_finance_pdf] Telegram rejected the document:', tgResp.status, tgData?.description);
      return { ok: false, error: 'PDF сформирован, но Telegram не принял файл. Попробуй ещё раз.' };
    }

    return { ok: true, message: `📄 Финансовый отчёт готов и отправлен (${result.transactionCount} операций, ${result.period.label}).` };
  }

  return { createTransaction, queryTransactions, getFinanceStats, exportFinancePdfTool };
}

module.exports = { createFinanceTools, autoCategorize };
