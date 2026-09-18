'use strict';

// ── Proactive Insights Engine — orchestrator ──────────────────────────────────
//
// Two entry points:
//   runDetectorsForUser(uid, opts)  — single user (data-change trigger)
//   runAllUsers(opts)               — all users (scheduled cron)
//
// Detector ↔ domain mapping (spec §23): only relevant detectors run per domain.

const { db }                  = require('../firebaseAdmin');
const txRepo                  = require('../repositories/transactions');
const goalsRepo               = require('../repositories/goals');
const tasksRepo               = require('../repositories/tasks');
const { INSIGHTS_CONFIG }     = require('./config');
const { HOME_BUDGET_CURRENCY } = require('../config');
const { normalizeTransactionsCurrency, needsFx, normalizeGoalsCurrency, goalsNeedFx } = require('../finance/normalizeCurrency');
const { getExchangeRates }    = require('../exchangeRates');
const {
  detectCashGap,
  detectPaymentCluster,
  detectCategorySpike,
  detectGoalOffTrack,
  detectOverdueTasks,
  detectMonthReviewReady,
} = require('./detectors');
const { upsertEvent, resolveEvent }  = require('./store');
const { notifyIfEligible }           = require('./notificationPolicy');

// ── Detector registry ─────────────────────────────────────────────────────────
// key = domain or event type; value = function that receives the full context.

const DETECTOR_FNS = {
  'finance.cash_gap':          (ctx) => detectCashGap(ctx),
  'finance.payment_cluster':   (ctx) => detectPaymentCluster(ctx),
  'finance.category_spike':    (ctx) => detectCategorySpike(ctx),
  'finance.goal_off_track':    (ctx) => detectGoalOffTrack(ctx),
  'tasks.overdue':             (ctx) => detectOverdueTasks(ctx),
  'system.month_review_ready': (ctx) => detectMonthReviewReady(ctx),
};

// Which detectors to run per changed domain (spec §23)
const DOMAIN_TO_DETECTORS = {
  finance: ['finance.cash_gap', 'finance.payment_cluster', 'finance.category_spike', 'finance.goal_off_track'],
  tasks:   ['tasks.overdue'],
  habits:  [],
  system:  ['system.month_review_ready'],
};

const ALL_DETECTORS = Object.keys(DETECTOR_FNS);

// ── Load user data from Firestore ─────────────────────────────────────────────

async function loadUserData(uid) {
  const [userSnap, transactions, goals, tasks] = await Promise.all([
    db.collection('users').doc(uid).get(),
    txRepo.getAllTransactions(uid),
    goalsRepo.getAllGoals(uid),
    tasksRepo.getAllTasks(uid),
  ]);

  const userData = userSnap.exists ? userSnap.data() : {};
  return { userData, transactions, goals, tasks };
}

// ── Run detectors for one user ────────────────────────────────────────────────

async function runDetectorsForUser(uid, { domains } = {}) {
  const { userData, transactions: rawTransactions, goals: rawGoals, tasks } = await loadUserData(uid);

  const tz       = userData.timezone || 'Europe/Moscow';
  const lang     = userData.language || 'ru';
  // Budget/analytics are always RUB; user.currency is only the input currency.
  const currency = HOME_BUDGET_CURRENCY;

  // Proactive monetary thresholds (category_spike.minIncreaseAmount,
  // payment_cluster.minTotalAmount, cash_gap.substantialChangeAmount) are
  // RUB-denominated config values — they need FX to be compared against a
  // non-RUB user's data even when that user's OWN transactions are all one
  // currency. This is a deliberate, narrower exception than the Finance
  // Engine's rule: engine arithmetic never needs FX for single-currency data,
  // but threshold CALIBRATION does whenever currency !== 'RUB'. See
  // detectors.js (convertThreshold) and store.js (checkSubstantialChange).
  const needsThresholdFx = currency !== 'RUB';

  const rates = (
    needsThresholdFx ||
    (Array.isArray(rawTransactions) && rawTransactions.length > 0 && needsFx(rawTransactions, currency)) ||
    (Array.isArray(rawGoals) && rawGoals.length > 0 && goalsNeedFx(rawGoals, currency))
  ) ? await getExchangeRates() : null;

  // Normalize ONCE, before any finance detector runs — the same rule as the
  // Finance Calculation Engine: never let a detector sum raw amounts across
  // currencies, invent its own conversion, or treat an unresolvable legacy
  // currency as RUB.
  let transactions = rawTransactions;
  if (Array.isArray(rawTransactions) && rawTransactions.length > 0) {
    const normalized = normalizeTransactionsCurrency(rawTransactions, currency, rates);
    if (normalized.ok) {
      transactions = normalized.transactions;
    } else {
      // FX required but unavailable, or a transaction's real currency can't be
      // proven — finance detectors must never compute on unconvertible or
      // unresolvable data. Safe degradation: run this pass as if there were no
      // transaction data (every finance calculator/detector already treats an
      // empty array as insufficient_data / no signal), so no detector fires a
      // false event and no event is wrongly resolved.
      console.warn(`[PROACTIVE_DETECTOR] uid=${uid} financeDataOk=false reason=fx_unavailable_or_unknown_currency currency=${currency}`);
      transactions = [];
    }
  }

  let goals = rawGoals;
  if (Array.isArray(rawGoals) && rawGoals.length > 0) {
    const normalizedGoals = normalizeGoalsCurrency(rawGoals, currency, rates);
    goals = normalizedGoals.ok ? normalizedGoals.goals : [];
    if (!normalizedGoals.ok) {
      console.warn(`[PROACTIVE_DETECTOR] uid=${uid} goalsCurrencyOk=false reason=fx_unavailable currency=${currency}`);
    }
  }

  const ctx = { uid, transactions, goals, tasks, timezone: tz, lang, currency, rates };

  // Determine which detectors to run
  let detectorKeys = ALL_DETECTORS;
  if (domains) {
    const domainList = Array.isArray(domains) ? domains : [domains];
    detectorKeys = domainList.flatMap(d => DOMAIN_TO_DETECTORS[d] || []);
    // Deduplicate
    detectorKeys = [...new Set(detectorKeys)];
  }

  // Collect all detector outputs; isolate failures per detector
  const allOutputs = [];
  for (const key of detectorKeys) {
    const fn = DETECTOR_FNS[key];
    if (!fn) continue;
    try {
      const outputs = fn(ctx);
      for (const o of (Array.isArray(outputs) ? outputs : [])) {
        allOutputs.push({ detectorKey: key, output: o });
      }
    } catch (err) {
      console.warn(`[PROACTIVE_DETECTOR] uid=${uid} type=${key} detector_err=${err.message}`);
    }
  }

  // Process: upsert or resolve, with per-operation failure isolation
  const stats      = { created: 0, updated: 0, resolved: 0, skipped: 0, errors: 0 };
  const toNotify   = [];

  for (const { detectorKey, output } of allOutputs) {
    try {
      if (output.type === 'resolve') {
        const res = await resolveEvent(uid, output.fingerprint);
        if (res.result === 'resolved') stats.resolved++;
        console.log(`[PROACTIVE_DETECTOR] uid=${uid} type=${detectorKey} result=${res.result} fingerprint=${output.fingerprint}`);

      } else if (output.type === 'upsert') {
        const res = await upsertEvent(uid, output, { currency, rates });
        const r   = res.result;
        if (r === 'created')            { stats.created++;  toNotify.push(output); }
        if (r === 'updated')            { stats.updated++;  }
        if (r === 'updated_substantial'){ stats.updated++;  toNotify.push(output); }
        if (r === 'skipped')            { stats.skipped++;  }
        console.log(`[PROACTIVE_DETECTOR] uid=${uid} type=${detectorKey} result=${r} severity=${output.severity} fingerprint=${output.fingerprint}`);
      }
    } catch (err) {
      stats.errors++;
      console.warn(`[PROACTIVE_DETECTOR] uid=${uid} type=${detectorKey} store_err=${err.message}`);
    }
  }

  // Notify: per-notification failure is isolated
  const token = process.env.TELEGRAM_BOT_TOKEN;
  for (const insight of toNotify) {
    try {
      const n = await notifyIfEligible(
        uid,
        { ...insight, fingerprint: insight.fingerprint },
        userData,
        token,
      );
      console.log(`[PROACTIVE_NOTIFY] uid=${uid} type=${insight.eventType} sent=${n.sent} reason=${n.reason || ''}`);
    } catch (err) {
      console.warn(`[PROACTIVE_NOTIFY] uid=${uid} type=${insight.eventType} err=${err.message}`);
    }
  }

  return { uid, ...stats };
}

// ── Run detectors for all users ───────────────────────────────────────────────

async function runAllUsers({ domains } = {}) {
  const batchSize = INSIGHTS_CONFIG.engine.batchSize;
  const t0        = Date.now();

  // Load all user IDs (paginate in batches of 500 to stay within Firestore limits)
  const usersSnap = await db.collection('users').limit(500).get();
  const uids      = usersSnap.docs.map(d => d.id);

  const totals = { usersProcessed: 0, created: 0, updated: 0, resolved: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < uids.length; i += batchSize) {
    const batch   = uids.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(uid => runDetectorsForUser(uid, { domains }))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        totals.usersProcessed++;
        totals.created  += r.value.created  || 0;
        totals.updated  += r.value.updated  || 0;
        totals.resolved += r.value.resolved || 0;
        totals.skipped  += r.value.skipped  || 0;
        totals.errors   += r.value.errors   || 0;
      } else {
        totals.errors++;
        console.warn('[PROACTIVE_ENGINE] user_err:', r.reason?.message);
      }
    }
  }

  console.log(
    `[PROACTIVE_ENGINE] usersProcessed=${totals.usersProcessed} ` +
    `created=${totals.created} updated=${totals.updated} resolved=${totals.resolved} ` +
    `errors=${totals.errors} duration=${Date.now() - t0}ms`
  );

  return totals;
}

module.exports = { runDetectorsForUser, runAllUsers, loadUserData };
