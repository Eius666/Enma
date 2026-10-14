'use strict';

// The ONE shared orchestrator behind export_finance_pdf (Telegram tool)
// and the Web /api/ai/exportFinancePdf route (PHASE 7: "предпочти один
// общий генератор, который обслуживает Web и Telegram").
//
// Responsibilities, strictly in this order:
//   1. Resolve the requested period into concrete dates (deterministic for
//      named periods — never re-derived by the LLM).
//   2. Fetch the FULL transaction/goal history via the existing,
//      authoritative repositories (no manual pagination/limit — see
//      repositories/transactions.js: a single .where(userId==).get() with
//      no .limit() already returns every matching document).
//   3. Normalize currency via the existing, safe legacy logic — never a
//      parallel/invented conversion.
//   4. Hand already-correct numbers to financeReportData (pure shaping)
//      then financeReportPdf (pure rendering).
//
// Returns either { ok: true, buffer, filename, pageCount, transactionCount }
// or { ok: false, code, error } — NEVER ok:true unless `buffer` is a real,
// fully-written PDF (the render promise only resolves after pdfkit's
// 'end' event, i.e. the stream is actually finished).

const txRepo    = require('../repositories/transactions');
const goalsRepo = require('../repositories/goals');
const { db } = require('../firebaseAdmin');
const { getExchangeRates } = require('../exchangeRates');
const { normalizeTransactionsCurrency, needsFx, goalsNeedFx } = require('../finance/normalizeCurrency');
const { HOME_BUDGET_CURRENCY } = require('../config');
const { userToday, addMonths } = require('../finance/dateHelpers');
const { buildReportData } = require('./financeReportData');
const { renderFinanceReportPdf } = require('./financeReportPdf');

// A generous, explicit safety cap rather than a controlled async
// generation pipeline (PHASE 3 offers either) — a background-job/polling
// system for PDF export would be a materially larger feature (job queue,
// status polling, Telegram follow-up delivery) than "add PDF export", and
// in practice no individual's finance history realistically approaches
// this; past it we refuse outright with a clear, honest message rather
// than ever producing a PDF that silently represents only part of the
// data as the whole.
const MAX_TRANSACTIONS = 5000;

const PERIOD_LABELS = {
  today: 'Сегодня', week: 'За неделю', month: 'За месяц',
  quarter: 'За квартал', year: 'За год', all: 'За всё время',
};

class ExportFinancePdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resolvePeriod({ period, dateFrom, dateTo, timezone }) {
  const today = userToday(timezone || 'Europe/Moscow');

  if (period === 'custom') {
    if (!dateFrom || !dateTo) {
      throw new ExportFinancePdfError('INVALID_DATE_RANGE', 'Для периода "custom" нужны dateFrom и dateTo.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      throw new ExportFinancePdfError('INVALID_DATE_RANGE', 'dateFrom/dateTo должны быть в формате YYYY-MM-DD.');
    }
    if (dateFrom > dateTo) {
      throw new ExportFinancePdfError('INVALID_DATE_RANGE', 'dateFrom не может быть позже dateTo.');
    }
    return { key: 'custom', from: dateFrom, to: dateTo, label: `${dateFrom} — ${dateTo}` };
  }

  if (period === 'today')   return { key: 'today',   from: today, to: today, label: PERIOD_LABELS.today };
  if (period === 'week') {
    const from = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);
    return { key: 'week', from, to: today, label: PERIOD_LABELS.week };
  }
  if (period === 'month') {
    const from = `${today.slice(0, 7)}-01`;
    return { key: 'month', from, to: today, label: `${PERIOD_LABELS.month} (${today.slice(0, 7)})` };
  }
  if (period === 'quarter') {
    const ym = today.slice(0, 7);
    const from = addMonths(ym, -2) + '-01';
    return { key: 'quarter', from, to: today, label: PERIOD_LABELS.quarter };
  }
  if (period === 'year') {
    const from = `${today.slice(0, 4)}-01-01`;
    return { key: 'year', from, to: today, label: `${PERIOD_LABELS.year} (${today.slice(0, 4)})` };
  }
  if (period === 'all' || !period) {
    return { key: 'all', from: null, to: null, label: PERIOD_LABELS.all };
  }

  throw new ExportFinancePdfError('INVALID_PERIOD', `Неизвестный период: "${period}". Используй today/week/month/quarter/year/all/custom.`);
}

/**
 * @param {object} params
 * @param {string} params.uid - MUST come from a verified auth token at the caller; never trust a model- or request-supplied uid.
 * @param {string} [params.period]
 * @param {string} [params.dateFrom]
 * @param {string} [params.dateTo]
 * @param {boolean} [params.includeTransactions]
 * @param {boolean} [params.includeCategories]
 * @param {boolean} [params.includeAccounts]
 * @param {boolean} [params.includeGoals]
 * @param {boolean} [params.includeCharts]
 * @param {string} [params.timezone]
 */
async function exportFinancePdf(params) {
  const {
    uid, period = 'all', dateFrom = null, dateTo = null, timezone,
    includeTransactions = true, includeCategories = true, includeAccounts = true,
    includeGoals = true, includeCharts = true,
  } = params;

  if (!uid || typeof uid !== 'string') {
    return { ok: false, code: 'UNAUTHENTICATED', error: 'Не удалось определить пользователя.' };
  }

  let resolvedPeriod;
  try {
    resolvedPeriod = resolvePeriod({ period, dateFrom, dateTo, timezone });
  } catch (err) {
    if (err instanceof ExportFinancePdfError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }

  // ── Fetch (full retrieval — see repositories/transactions.js) ─────────
  let allTransactionsRaw, goalsRaw;
  try {
    [allTransactionsRaw, goalsRaw] = await Promise.all([
      txRepo.getAllTransactions(uid),
      goalsRepo.getAllGoals(uid),
    ]);
  } catch (err) {
    return { ok: false, code: err.code || 'DATA_UNAVAILABLE', error: 'Не удалось загрузить финансовые данные. Попробуй чуть позже.' };
  }

  if (allTransactionsRaw.length > MAX_TRANSACTIONS) {
    return {
      ok: false, code: 'TOO_MANY_TRANSACTIONS',
      error: `У тебя ${allTransactionsRaw.length} операций — это больше, чем отчёт может надёжно обработать за один раз (лимит ${MAX_TRANSACTIONS}). Попробуй выбрать более короткий период.`,
    };
  }

  // currentAmountRub lives on the raw Firestore doc but
  // repositories/goals.js's normalizeGoal doesn't surface it (it predates
  // this field) — attach it here rather than editing that shared
  // normalizer's output shape for every OTHER caller.
  let goalDocs = [];
  try {
    const goalSnaps = await db.collection('goals').where('userId', '==', uid).get();
    const rubByid = new Map(goalSnaps.docs.map(d => [d.id, d.data().currentAmountRub]));
    goalDocs = goalsRaw.map(g => ({ ...g, currentAmountRub: rubByid.get(g.id) }));
  } catch (err) {
    return { ok: false, code: 'DATA_UNAVAILABLE', error: 'Не удалось загрузить данные целей. Попробуй чуть позже.' };
  }

  // ── Currency normalization (existing, safe legacy logic only) ─────────
  const currency = HOME_BUDGET_CURRENCY;
  let rates = null;
  if (needsFx(allTransactionsRaw, currency) || goalsNeedFx(goalDocs, currency)) {
    rates = await getExchangeRates();
  }

  const normalized = normalizeTransactionsCurrency(allTransactionsRaw, currency, rates);
  if (!normalized.ok) {
    return {
      ok: false, code: 'FX_UNAVAILABLE',
      error: 'Часть операций в другой валюте, курс обмена сейчас недоступен — точный отчёт невозможен. Попробуй чуть позже.',
    };
  }
  const allTransactions = normalized.transactions;

  const periodTransactions = resolvedPeriod.from
    ? txRepo.filterByPeriod(allTransactions, resolvedPeriod.from, resolvedPeriod.to)
    : allTransactions;

  // ── The ONE authoritative balance figure — never recomputed elsewhere ──
  const freeBalance = txRepo.calculateCurrentBalance(allTransactions, currency, rates);

  const reportData = buildReportData({
    allTransactions, periodTransactions, goals: goalDocs,
    freeBalance, rates, period: resolvedPeriod, currency,
    generatedAt: new Date(),
  });

  let buffer;
  try {
    buffer = await renderFinanceReportPdf(reportData, {
      includeTransactions, includeCategories, includeAccounts, includeGoals, includeCharts,
    });
  } catch (err) {
    console.error('[exportFinancePdf] render failed:', err.message);
    return { ok: false, code: 'PDF_RENDER_FAILED', error: 'Не удалось сформировать PDF. Попробуй ещё раз.' };
  }

  if (!buffer || buffer.length === 0 || buffer.slice(0, 4).toString('latin1') !== '%PDF') {
    // Never claim success for a file that isn't actually a usable PDF.
    return { ok: false, code: 'PDF_RENDER_FAILED', error: 'Не удалось сформировать PDF. Попробуй ещё раз.' };
  }

  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `ENMA-finance-report-${resolvedPeriod.key}-${dateTag}.pdf`;

  return {
    ok: true,
    buffer,
    filename,
    transactionCount: periodTransactions.length,
    period: resolvedPeriod,
  };
}

module.exports = { exportFinancePdf, resolvePeriod, ExportFinancePdfError, MAX_TRANSACTIONS };
