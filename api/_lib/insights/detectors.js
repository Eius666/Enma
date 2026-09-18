'use strict';

// ── Proactive detectors — code determines what happened; LLM never used here ──
//
// Each detector returns an array of operations:
//   { type: 'upsert', fingerprint, eventType, domain, severity, title, bodyText, facts, ... }
//   { type: 'resolve', fingerprint }
//
// Detectors are PURE with respect to Firestore — they read nothing and write nothing.
// All Firestore interaction happens in store.js via the engine.

const { calculateCashflow }    = require('../finance/cashflow');
const { calculateLeakSignals } = require('../finance/leaks');
const { calculateGoalPlan }    = require('../finance/goals');
const { calculateMetrics }     = require('../finance/metrics');
const { round }                = require('../finance/constants');
const { currentYearMonth }     = require('../finance/dateHelpers');

const { INSIGHTS_CONFIG, determineSeverity, DETECTOR_VERSION } = require('./config');
const { renderInsightText, getMonthLabel }                      = require('./templates');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFingerprint(...parts) {
  return parts.join(':').replace(/[^a-zA-Z0-9:.\-_]/g, '');
}

function nowPlusDays(days) {
  return Date.now() + days * 86400000;
}

function userTodayStr(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function endOfMonthMs(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999).getTime();
}

// ── Detector 1: finance.cash_gap ──────────────────────────────────────────────
//
// Uses calculateCashflow from the existing Finance Engine.
// Creates event when projected closing balance < 0.
// Resolves event when projected balance returns positive.

function detectCashGap({ transactions, timezone, lang }) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const cf = calculateCashflow({ transactions, timezone });
  if (cf.status !== 'ok') return [];

  const cfg         = INSIGHTS_CONFIG['finance.cash_gap'];
  const monthKey    = cf.period;
  const fingerprint = makeFingerprint('finance.cash_gap', monthKey);

  const projectedBalance = cf.projections.closingBalance.value;
  const currentBalance   = cf.openingBalance.value;

  // Resolution: projected balance recovered
  if (projectedBalance >= cfg.projectedBalanceThreshold && !cf.cashGap) {
    return [{ type: 'resolve', fingerprint }];
  }

  const gapAmount = Math.abs(Math.min(projectedBalance, 0));

  const metrics        = calculateMetrics({ transactions, timezone });
  const avgMonthlyIncome = metrics.status === 'ok'
    ? (metrics.averages?.monthlyIncome || 0)
    : 0;

  const facts = {
    currentBalance:   round(currentBalance,   2),
    projectedBalance: round(projectedBalance, 2),
    gapAmount:        round(gapAmount,        2),
    gapDate:          monthKey,
    avgMonthlyIncome: round(avgMonthlyIncome, 2),
    cashGap:          cf.cashGap,
  };

  const severity = determineSeverity('finance.cash_gap', facts);
  const text     = renderInsightText('finance.cash_gap', facts, lang);

  return [{
    type:            'upsert',
    fingerprint,
    eventType:       'finance.cash_gap',
    domain:          'finance',
    severity,
    title:           text.title,
    bodyText:        text.body,
    facts,
    detectorVersion: DETECTOR_VERSION,
    expiresAt:       endOfMonthMs(monthKey) + 2 * 86400000,
    action:          { type: 'skill', target: 'finance.cashflow', params: {} },
  }];
}

// ── Detector 2: finance.payment_cluster ───────────────────────────────────────
//
// Identifies multiple significant payments within a short upcoming window.
// Sources: forward-dated expense transactions + recurring signals from leaks engine.
// Heuristic signals are labeled "certainty: heuristic" so UI can hedge.

function detectPaymentCluster({ transactions, timezone, lang }) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const cfg    = INSIGHTS_CONFIG['finance.payment_cluster'];
  const tz     = timezone || 'Europe/Moscow';
  const nowStr = userTodayStr(tz);

  const windowDate = new Date(Date.now() + cfg.windowDays * 86400000);
  const windowStr  = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(windowDate);

  // 1. Forward-dated expense transactions (confirmed)
  const confirmed = transactions
    .filter(t => t.type === 'expense' && t.date && t.date > nowStr && t.date <= windowStr)
    .map(t => ({ amount: t.amount || 0, date: t.date, certainty: 'confirmed' }));

  // 2. Recurring payments estimated to hit within the window (heuristic)
  const leaks = calculateLeakSignals({ transactions, timezone });
  const heuristic = [];
  if (leaks.status === 'ok') {
    for (const sig of (leaks.signals || [])) {
      if (sig.type !== 'recurring' || sig.confidence < cfg.minConfidence) continue;
      if (!sig.latestDate) continue;
      const nextDate = new Date(sig.latestDate + 'T12:00:00Z');
      nextDate.setDate(nextDate.getDate() + (sig.avgInterval || 30));
      const nextStr = nextDate.toISOString().slice(0, 10);
      if (nextStr > nowStr && nextStr <= windowStr) {
        heuristic.push({ amount: sig.avgAmount || 0, date: nextStr, certainty: 'heuristic' });
      }
    }
  }

  const allPayments = [...confirmed, ...heuristic];
  if (allPayments.length < cfg.minPaymentCount) return [];

  const total = allPayments.reduce((s, p) => s + p.amount, 0);
  if (total < cfg.minTotalAmount) return [];

  const sorted      = allPayments.slice().sort((a, b) => a.date.localeCompare(b.date));
  const hasHeuristic = allPayments.some(p => p.certainty === 'heuristic');
  const weekBucket  = Math.floor(parseInt(nowStr.slice(8, 10), 10) / 7);
  const fingerprint = makeFingerprint('finance.payment_cluster', nowStr.slice(0, 7), weekBucket.toString());

  const facts = {
    count:     allPayments.length,
    total:     round(total, 2),
    from:      sorted[0].date,
    to:        sorted[sorted.length - 1].date,
    certainty: hasHeuristic ? 'heuristic' : 'confirmed',
  };

  const text  = renderInsightText('finance.payment_cluster', facts, lang);
  const title = hasHeuristic
    ? `Похоже, ${text.title.charAt(0).toLowerCase() + text.title.slice(1)}`
    : text.title;

  return [{
    type:            'upsert',
    fingerprint,
    eventType:       'finance.payment_cluster',
    domain:          'finance',
    severity:        'warning',
    title,
    bodyText:        text.body,
    facts,
    detectorVersion: DETECTOR_VERSION,
    expiresAt:       nowPlusDays(cfg.expiryOffsetDays),
    action:          { type: 'skill', target: 'finance.cashflow', params: {} },
  }];
}

// ── Detector 3: finance.category_spike ────────────────────────────────────────
//
// Reuses calculateLeakSignals from the existing leaks engine.
// Applies two guards: minIncreasePct AND minIncreaseAmount.
// Both must be satisfied — prevents 100→250 (+150%) from triggering.

function detectCategorySpike({ transactions, timezone, lang }) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const cfg   = INSIGHTS_CONFIG['finance.category_spike'];
  const leaks = calculateLeakSignals({ transactions, timezone });
  if (leaks.status !== 'ok') return [];

  const qualified = (leaks.signals || []).filter(s =>
    s.type === 'category_spike' &&
    s.increasePct >= cfg.minIncreasePct &&
    s.increase    >= cfg.minIncreaseAmount
  );

  const monthKey = currentYearMonth(timezone || 'Europe/Moscow');

  return qualified.map(sig => {
    const fingerprint = makeFingerprint('finance.category_spike', monthKey, sig.category);

    const facts = {
      category:    sig.category,
      baseline:    round(sig.prevAmt,    2),
      current:     round(sig.currentAmt, 2),
      increase:    round(sig.increase,   2),
      increasePct: round(sig.increasePct, 1),
    };

    const severity = determineSeverity('finance.category_spike', facts);
    const text     = renderInsightText('finance.category_spike', facts, lang);

    return {
      type:            'upsert',
      fingerprint,
      eventType:       'finance.category_spike',
      domain:          'finance',
      severity,
      title:           text.title,
      bodyText:        text.body,
      facts,
      detectorVersion: DETECTOR_VERSION,
      expiresAt:       nowPlusDays(cfg.expiryOffsetDays),
      action:          { type: 'skill', target: 'finance.leaks', params: {} },
    };
  });
}

// ── Detector 4: finance.goal_off_track ────────────────────────────────────────
//
// Uses calculateGoalPlan from the existing goals engine.
// Only fires for goals with a deadline (status: 'with_deadline').
// Resolves events for goals that have become feasible again.

function detectGoalOffTrack({ transactions, goals, timezone, lang }) {
  if (!Array.isArray(goals) || goals.length === 0) return [];

  const cfg  = INSIGHTS_CONFIG['finance.goal_off_track'];
  const plan = calculateGoalPlan({ goals, transactions, timezone });
  if (plan.status !== 'ok') return [];

  const results = [];

  for (const g of (plan.goals || [])) {
    const fingerprint = makeFingerprint('finance.goal_off_track', g.id);

    if (g.status !== 'with_deadline') continue;

    if (g.feasible === true || !g.shortfall || g.shortfall.value <= 0) {
      results.push({ type: 'resolve', fingerprint });
      continue;
    }

    const requiredMonthly = g.requiredMonthly?.value || 0;
    const actualMonthly   = plan.avgSavingsCapacity  || 0;
    const monthlyGap      = round(g.shortfall.value, 2);
    const shortfallPct    = requiredMonthly > 0
      ? round(monthlyGap / requiredMonthly * 100, 1)
      : 0;

    if (shortfallPct < cfg.minShortfallPct) continue;

    const facts = {
      goalId:          g.id,
      goalTitle:       g.title,
      requiredMonthly: round(requiredMonthly, 2),
      actualMonthly:   round(actualMonthly,   2),
      monthlyGap,
      shortfallPct,
      deadline:        g.deadline,
    };

    const severity = determineSeverity('finance.goal_off_track', facts);
    const text     = renderInsightText('finance.goal_off_track', facts, lang);

    results.push({
      type:            'upsert',
      fingerprint,
      eventType:       'finance.goal_off_track',
      domain:          'finance',
      severity,
      title:           text.title,
      bodyText:        text.body,
      facts,
      detectorVersion: DETECTOR_VERSION,
      expiresAt:       nowPlusDays(cfg.expiryOffsetDays),
      action:          { type: 'skill', target: 'finance.goal', params: { goalId: g.id } },
      sourceEntityIds: [g.id],
    });
  }

  return results;
}

// ── Detector 5: tasks.overdue ─────────────────────────────────────────────────
//
// Deterministic: dueDate < userToday AND task not completed.
// Uses user's timezone — never server timezone.
// Resolves event immediately when task is completed.
// Does NOT create a new event per day — updates the existing fingerprint.

function detectOverdueTasks({ tasks, timezone, lang }) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const cfg    = INSIGHTS_CONFIG['tasks.overdue'];
  const tz     = timezone || 'Europe/Moscow';
  const todayStr = userTodayStr(tz);
  const results  = [];

  for (const task of tasks) {
    const fingerprint = makeFingerprint('tasks.overdue', task.id);
    const isComplete  = task.completed || task.done || task.status === 'completed';

    if (isComplete) {
      results.push({ type: 'resolve', fingerprint });
      continue;
    }

    const dueDate = task.date || task.dueDate || task.deadline;
    if (!dueDate || dueDate >= todayStr) continue;

    const dueMs      = new Date(dueDate + 'T12:00:00Z').getTime();
    const overdueDays = Math.floor((Date.now() - dueMs) / 86400000);
    if (overdueDays <= 0) continue;

    const facts = {
      taskId:     task.id,
      taskTitle:  task.title || 'Без названия',
      dueDate,
      overdueDays,
      taskStatus: task.status || 'active',
    };

    const severity = determineSeverity('tasks.overdue', facts);
    const text     = renderInsightText('tasks.overdue', facts, lang);

    results.push({
      type:            'upsert',
      fingerprint,
      eventType:       'tasks.overdue',
      domain:          'tasks',
      severity,
      title:           text.title,
      bodyText:        text.body,
      facts,
      detectorVersion: DETECTOR_VERSION,
      expiresAt:       nowPlusDays(cfg.expiryOffsetDays),
      action:          { type: 'skill', target: 'tasks.prioritize', params: { taskId: task.id } },
      sourceEntityIds: [task.id],
    });
  }

  return results;
}

// ── Detector 6: system.month_review_ready ─────────────────────────────────────
//
// Fires once in the first week of a new month for the previous month's review.
// One event per month — deterministic fingerprint prevents duplicates.

function detectMonthReviewReady({ timezone, lang }) {
  const cfg = INSIGHTS_CONFIG['system.month_review_ready'];
  const tz  = timezone || 'Europe/Moscow';
  const now = new Date();

  const dayOfMonth = parseInt(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: 'numeric' }).format(now),
    10
  );
  if (dayOfMonth > cfg.firstDayWindowDays) return [];

  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthStr  = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit',
  }).format(prevMonthDate);

  const fingerprint = makeFingerprint('system.month_review_ready', prevMonthStr);
  const monthLabel  = getMonthLabel(prevMonthStr, lang || 'ru');

  const facts = { month: prevMonthStr, monthLabel };
  const text  = renderInsightText('system.month_review_ready', facts, lang);

  return [{
    type:            'upsert',
    fingerprint,
    eventType:       'system.month_review_ready',
    domain:          'system',
    severity:        'info',
    title:           text.title,
    bodyText:        text.body,
    facts,
    detectorVersion: DETECTOR_VERSION,
    expiresAt:       nowPlusDays(cfg.expiryOffsetDays),
    action:          { type: 'skill', target: 'finance.month_review', params: {} },
  }];
}

module.exports = {
  detectCashGap,
  detectPaymentCluster,
  detectCategorySpike,
  detectGoalOffTrack,
  detectOverdueTasks,
  detectMonthReviewReady,
};
