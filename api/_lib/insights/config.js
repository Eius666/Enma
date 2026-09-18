'use strict';

// ── Proactive Insights Engine — Central Configuration ─────────────────────────
// All thresholds, cooldowns, and weights live here.
// Detectors NEVER hardcode business logic — they import this.

const DETECTOR_VERSION = '1.0';

const INSIGHTS_CONFIG = {

  // ── finance.cash_gap ─────────────────────────────────────────────────────────
  'finance.cash_gap': {
    projectedBalanceThreshold: 0,          // gap when projected closing balance < 0
    substantialChangeAmount:   5000,       // re-notify if |gap| worsens by this much
    cooldownMs:  24 * 60 * 60 * 1000,     // 24h between Telegram notifications
    expiryOffsetDays: 33,                  // ~end of month + buffer
    detectorVersion: DETECTOR_VERSION,
  },

  // ── finance.payment_cluster ───────────────────────────────────────────────────
  'finance.payment_cluster': {
    windowDays:      5,
    minTotalAmount:  10000,
    minPaymentCount: 2,
    minConfidence:   0.70,
    cooldownMs:  7 * 24 * 60 * 60 * 1000,
    expiryOffsetDays: 7,
    detectorVersion: DETECTOR_VERSION,
  },

  // ── finance.category_spike ────────────────────────────────────────────────────
  'finance.category_spike': {
    minIncreasePct:    30,     // mirrors LEAK_SPIKE_THRESHOLD_PCT in finance/constants
    minIncreaseAmount: 1000,   // absolute floor — 100→250 (+150%) is NOT a spike
    cooldownMs:  7 * 24 * 60 * 60 * 1000,
    expiryOffsetDays: 33,
    detectorVersion: DETECTOR_VERSION,
  },

  // ── finance.goal_off_track ────────────────────────────────────────────────────
  'finance.goal_off_track': {
    minShortfallPct: 10,       // off-track only if shortfall > 10% of required pace
    cooldownMs:  7 * 24 * 60 * 60 * 1000,
    expiryOffsetDays: 33,
    detectorVersion: DETECTOR_VERSION,
  },

  // ── tasks.overdue ─────────────────────────────────────────────────────────────
  'tasks.overdue': {
    criticalOverdueDays: 3,    // critical when overdue >= 3 days
    cooldownMs:  24 * 60 * 60 * 1000,
    expiryOffsetDays: 30,
    detectorVersion: DETECTOR_VERSION,
  },

  // ── system.month_review_ready ─────────────────────────────────────────────────
  'system.month_review_ready': {
    firstDayWindowDays: 7,     // only fire in first 7 days of new month
    cooldownMs:  28 * 24 * 60 * 60 * 1000,
    expiryOffsetDays: 25,
    detectorVersion: DETECTOR_VERSION,
  },

  // ── Quiet hours ───────────────────────────────────────────────────────────────
  quietHours: {
    startHour: 22,   // local time (user's timezone)
    endHour:   8,
  },

  // ── Scheduler / engine ────────────────────────────────────────────────────────
  engine: {
    batchSize:       5,    // concurrent user slots per run
    maxTransactions: 500,
    maxGoals:        50,
    maxTasks:        200,
  },

  // ── Ranking score weights ─────────────────────────────────────────────────────
  ranking: {
    severityWeight:   { critical: 100, warning: 50, info: 10 },
    urgencyMaxScore:  30,    // points for deadline proximity
    freshnessMaxScore:20,    // points for being newly detected
    impactMaxScore:   30,    // points for financial magnitude
    impactDivisor:    1000,  // amount / divisor → score points (capped at max)
  },
};

// ── EVENT_REGISTRY — canonical definition per event type ─────────────────────

const EVENT_REGISTRY = {
  'finance.cash_gap': {
    id:      'finance.cash_gap',
    domain:  'finance',
    action:  { type: 'skill', target: 'finance.cashflow', params: {} },
  },
  'finance.payment_cluster': {
    id:      'finance.payment_cluster',
    domain:  'finance',
    action:  { type: 'skill', target: 'finance.cashflow', params: {} },
  },
  'finance.category_spike': {
    id:      'finance.category_spike',
    domain:  'finance',
    action:  { type: 'skill', target: 'finance.leaks', params: {} },
  },
  'finance.goal_off_track': {
    id:      'finance.goal_off_track',
    domain:  'finance',
    action:  { type: 'skill', target: 'finance.goal', params: {} },
  },
  'tasks.overdue': {
    id:      'tasks.overdue',
    domain:  'tasks',
    action:  { type: 'skill', target: 'tasks.prioritize', params: {} },
  },
  'system.month_review_ready': {
    id:      'system.month_review_ready',
    domain:  'system',
    action:  { type: 'skill', target: 'finance.month_review', params: {} },
  },
};

// ── Severity — deterministic, no LLM ─────────────────────────────────────────

function determineSeverity(type, facts) {
  switch (type) {
    case 'finance.cash_gap': {
      const gap       = facts.gapAmount       || 0;
      const avgIncome = facts.avgMonthlyIncome || 0;
      if (avgIncome > 0 && gap >= avgIncome) return 'critical';
      return 'warning';
    }
    case 'finance.category_spike': {
      const pct = facts.increasePct || 0;
      if (pct >= 100) return 'critical';
      if (pct >= 50)  return 'warning';
      return 'info';
    }
    case 'finance.goal_off_track': {
      const spct = facts.shortfallPct || 0;
      if (spct >= 80) return 'critical';
      if (spct >= 40) return 'warning';
      return 'info';
    }
    case 'tasks.overdue': {
      const d = facts.overdueDays || 0;
      return d >= INSIGHTS_CONFIG['tasks.overdue'].criticalOverdueDays ? 'critical' : 'warning';
    }
    case 'finance.payment_cluster':      return 'warning';
    case 'system.month_review_ready':    return 'info';
    default:                             return 'info';
  }
}

// ── Ranking score — deterministic, no LLM ────────────────────────────────────

function computeInsightScore(insight) {
  const w = INSIGHTS_CONFIG.ranking;

  const severityScore = w.severityWeight[insight.severity] || 0;

  let urgencyScore = 0;
  if (insight.expiresAt) {
    const exMs = typeof insight.expiresAt.toMillis === 'function'
      ? insight.expiresAt.toMillis()
      : Number(insight.expiresAt);
    const daysLeft = Math.max(0, (exMs - Date.now()) / 86400000);
    urgencyScore = Math.min(w.urgencyMaxScore, Math.max(0, w.urgencyMaxScore - daysLeft));
  }

  const detectedMs = typeof insight.detectedAt?.toMillis === 'function'
    ? insight.detectedAt.toMillis()
    : Number(insight.detectedAt || 0);
  const ageHours     = (Date.now() - detectedMs) / 3600000;
  const freshnessScore = Math.min(w.freshnessMaxScore, Math.max(0, w.freshnessMaxScore - ageHours / 12));

  const amount = insight.facts?.gapAmount || insight.facts?.increase ||
                 insight.facts?.monthlyGap || insight.facts?.total || 0;
  const impactScore = Math.min(w.impactMaxScore, amount / w.impactDivisor);

  return Math.round(severityScore + urgencyScore + freshnessScore + impactScore);
}

module.exports = {
  INSIGHTS_CONFIG,
  EVENT_REGISTRY,
  determineSeverity,
  computeInsightScore,
  DETECTOR_VERSION,
};
