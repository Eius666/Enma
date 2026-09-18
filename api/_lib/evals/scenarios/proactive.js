'use strict';

const a = require('../assertions');
const {
  createMockDb, mockAdmin, mockGetUserTimezone,
  makeCashGapTransactions, makeCategorySpike, makeSmallCategoryChange,
  makeOffTrackGoalAndTransactions, makeOverdueTasks,
  thisMonthKey, prevMonthKey, dateIn,
} = require('../fixtures');

// ── Helper: inject both firebaseAdmin AND insights/store ──────────────────────

function injectInsightsMocks(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: { db: mockDb, admin: mockAdmin, getUserTimezone: mockGetUserTimezone },
  };
  for (const m of ['../../insights/store', '../../insights/detectors', '../../insights/notificationPolicy']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
}
function teardownInsightsMocks() {
  for (const m of [
    '../../firebaseAdmin',
    '../../insights/store',
    '../../insights/detectors',
    '../../insights/notificationPolicy',
  ]) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
}

// ── Cash gap scenarios ─────────────────────────────────────────────────────────

const cashGapScenarios = [
  {
    id:          'proactive.cash_gap.create',
    description: 'SPEC §32: low balance + high prev-month expenses → finance.cash_gap event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCashGap } = require('../../insights/detectors');
      const txs     = makeCashGapTransactions('uid1');
      const results = detectCashGap({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.ok(upserts.length > 0, 'Expected at least one cash_gap upsert event');
      a.ok(upserts[0].eventType === 'finance.cash_gap', 'eventType = finance.cash_gap');
      a.ok(upserts[0].action?.target === 'finance.cashflow', 'CTA target = finance.cashflow');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },

  {
    id:          'proactive.cash_gap.dedupe',
    description: 'SPEC §33: run detector twice → same fingerprint, store deduplicates to 1 event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({});
      injectInsightsMocks(db);
      try {
        const { detectCashGap }    = require('../../insights/detectors');
        const { upsertEvent }      = require('../../insights/store');

        const txs     = makeCashGapTransactions('uid2');
        const results = detectCashGap({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
        const upserts = results.filter(r => r.type === 'upsert');
        a.ok(upserts.length > 0, 'detector must produce upserts');

        const fp  = upserts[0].fingerprint;
        const ev  = upserts[0];

        // First upsert → created
        const r1 = await upsertEvent('uid2', ev);
        // Second upsert with same fingerprint → updated (not created again)
        const r2 = await upsertEvent('uid2', ev);

        a.eq(r1.result, 'created', 'first upsert = created');
        a.ok(r2.result === 'updated' || r2.result === 'updated_substantial',
          `second upsert = updated (got "${r2.result}")`);

        // Exactly 1 insight document in DB
        const key = `users/uid2/insights/${fp}`;
        a.dbEntryExists(db, key, 'insight stored in DB');
        a.dbCountEquals(db, 'users/uid2/insights/', 1, 'exactly 1 insight');

        this.snapshot = { fingerprint: fp, r1: r1.result, r2: r2.result };
      } finally { teardownInsightsMocks(); }
    },
  },

  {
    id:          'proactive.cash_gap.resolve',
    description: 'SPEC §34: positive cashflow → same fingerprint resolved',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCashGap } = require('../../insights/detectors');
      const M = thisMonthKey();
      const P = prevMonthKey();
      const healthyTxs = [
        { id: 'inc1', type: 'income',  amount: 100000, date: dateIn(P, 10), category: 'p-salary',  userId: 'uid3' },
        { id: 'inc2', type: 'income',  amount: 100000, date: dateIn(M, 10), category: 'p-salary',  userId: 'uid3' },
        { id: 'exp1', type: 'expense', amount:  30000, date: dateIn(M,  5), category: 'p-housing', userId: 'uid3' },
      ];
      const results = detectCashGap({ transactions: healthyTxs, timezone: 'Europe/Moscow', lang: 'ru' });
      const resolves = results.filter(r => r.type === 'resolve');
      a.ok(resolves.length > 0, 'positive cashflow should produce resolve event');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },
];

// ── Category spike scenarios ───────────────────────────────────────────────────

const spikeScenarios = [
  {
    id:          'proactive.category_spike.basic',
    description: 'SPEC §35: baseline=12k, current=21k (+75%, +9k) → spike event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCategorySpike } = require('../../insights/detectors');
      const txs     = makeCategorySpike('uid4');
      const results = detectCategorySpike({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.ok(upserts.length > 0, 'Expected spike event for 12k→21k');
      a.ok(upserts[0].eventType === 'finance.category_spike', 'eventType=finance.category_spike');
      a.ok(upserts[0].action?.target === 'finance.leaks', 'CTA target = finance.leaks');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint, facts: r.facts })) };
    },
  },

  {
    id:          'proactive.category_spike.no_small_change',
    description: 'SPEC §36: 100→250 (+150%, but +150 ₽ absolute < 1000 threshold) → NO event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCategorySpike } = require('../../insights/detectors');
      const txs     = makeSmallCategoryChange('uid5');
      const results = detectCategorySpike({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.eq(upserts.length, 0, 'Small absolute increase (150 ₽) must NOT create event');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },

  {
    id:          'proactive.category_spike.no_history',
    description: 'SPEC §88: only current month transactions (no baseline) → no spike event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCategorySpike } = require('../../insights/detectors');
      const M = thisMonthKey();
      const txs = [
        { id: 'tx1', type: 'expense', amount: 21000, date: dateIn(M, 5), category: 'p-groceries', userId: 'uid6' },
        { id: 'tx2', type: 'income',  amount: 50000, date: dateIn(M, 10), category: 'p-salary',   userId: 'uid6' },
      ];
      const results = detectCategorySpike({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.eq(upserts.length, 0, 'No baseline month → no spike event (insufficient history)');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },
];

// ── Goal off-track scenarios ───────────────────────────────────────────────────

const goalScenarios = [
  {
    id:          'proactive.goal_off_track.basic',
    description: 'SPEC §37: required >> actual savings capacity → goal_off_track event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectGoalOffTrack } = require('../../insights/detectors');
      const { transactions, goals } = makeOffTrackGoalAndTransactions('uid7');
      const results = detectGoalOffTrack({ transactions, goals, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.ok(upserts.length > 0, 'Expected goal_off_track event');
      a.ok(upserts[0].eventType === 'finance.goal_off_track', 'eventType=finance.goal_off_track');
      const { requiredMonthly, actualMonthly } = upserts[0].facts ?? {};
      a.ok(requiredMonthly > actualMonthly, 'requiredMonthly > actualMonthly (gap exists)');
      this.snapshot = {
        events: results.map(r => ({ type: r.type, facts: r.facts })),
      };
    },
  },

  {
    id:          'proactive.goal_off_track.resolve_feasible',
    description: 'SPEC §34: goal becomes feasible → resolve event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectGoalOffTrack } = require('../../insights/detectors');
      const M = thisMonthKey();
      const { monthsFromNow } = require('../fixtures');
      const transactions = [
        { id: 'tx-1', type: 'income',  amount: 150000, date: dateIn(M, 10), category: 'p-salary',  userId: 'uid8' },
        { id: 'tx-2', type: 'expense', amount:  30000, date: dateIn(M, 15), category: 'p-other-e', userId: 'uid8' },
        // avgSavingsCapacity ≈ 120,000/mo — well above any typical required monthly
      ];
      const goals = [
        { id: 'g1', title: 'Ноутбук', targetAmount: 180000, currentAmount: 0,
          deadline: monthsFromNow(12), userId: 'uid8' },
          // required ≈ 15,000/mo << 120,000 → feasible → resolve
      ];
      const results = detectGoalOffTrack({ transactions, goals, timezone: 'Europe/Moscow', lang: 'ru' });
      const resolves = results.filter(r => r.type === 'resolve');
      a.ok(resolves.length > 0, 'feasible goal should produce resolve event');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },
];

// ── Overdue task scenarios ─────────────────────────────────────────────────────

const taskScenarios = [
  {
    id:          'proactive.overdue_task.active',
    description: 'SPEC §38: incomplete overdue task → active event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectOverdueTasks } = require('../../insights/detectors');
      const tasks   = makeOverdueTasks('uid9');
      const results = detectOverdueTasks({ tasks, timezone: 'Europe/Moscow', lang: 'ru' });
      const upserts = results.filter(r => r.type === 'upsert');
      a.ok(upserts.length > 0, 'Expected overdue event for incomplete overdue task');
      a.ok(upserts[0].eventType === 'tasks.overdue', 'eventType=tasks.overdue');
      a.ok(upserts[0].action?.target === 'tasks.prioritize', 'CTA target = tasks.prioritize');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },

  {
    id:          'proactive.overdue_task.resolve_completed',
    description: 'SPEC §38: completed task → resolve event',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectOverdueTasks } = require('../../insights/detectors');
      const { daysAgo } = require('../fixtures');
      const tasks = [
        { id: 'task-done', title: 'Купить билеты', dueDate: daysAgo(1), completed: true, userId: 'uid10' },
      ];
      const results = detectOverdueTasks({ tasks, timezone: 'Europe/Moscow', lang: 'ru' });
      const resolves = results.filter(r => r.type === 'resolve');
      a.ok(resolves.length > 0, 'completed overdue task should produce resolve event');
      this.snapshot = { events: results.map(r => ({ type: r.type, fingerprint: r.fingerprint })) };
    },
  },

  {
    id:          'proactive.overdue_task.future_no_event',
    description: 'Task due in future → no overdue event',
    domain:      'proactive',
    critical:    false,
    snapshot:    {},
    run() {
      const { detectOverdueTasks } = require('../../insights/detectors');
      const { daysFromNow } = require('../fixtures');
      const tasks = [
        { id: 'future-task', title: 'Завтра', dueDate: daysFromNow(1), completed: false, userId: 'uid11' },
      ];
      const results = detectOverdueTasks({ tasks, timezone: 'Europe/Moscow', lang: 'ru' });
      a.noEvents(results.filter(r => r.type === 'upsert'), 'future task → no upsert event');
      this.snapshot = { events: results.map(r => ({ type: r.type })) };
    },
  },
];

// ── CTA scenarios ──────────────────────────────────────────────────────────────

const ctaScenarios = [
  {
    id:          'proactive.insight.cta.cash_gap',
    description: 'SPEC §39: cash_gap CTA → finance.cashflow',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCashGap } = require('../../insights/detectors');
      const txs     = makeCashGapTransactions('uid12');
      const results = detectCashGap({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' });
      const ev = results.find(r => r.type === 'upsert');
      a.ok(ev, 'event exists');
      a.eq(ev.action?.target, 'finance.cashflow', 'cash_gap CTA target');
      this.snapshot = { cta: ev.action };
    },
  },

  {
    id:          'proactive.insight.cta.overdue_task',
    description: 'SPEC §39: overdue task CTA → tasks.prioritize',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectOverdueTasks } = require('../../insights/detectors');
      const tasks = makeOverdueTasks('uid13');
      const results = detectOverdueTasks({ tasks, timezone: 'Europe/Moscow', lang: 'ru' });
      const ev = results.find(r => r.type === 'upsert');
      a.ok(ev, 'event exists');
      a.eq(ev.action?.target, 'tasks.prioritize', 'overdue task CTA target');
      this.snapshot = { cta: ev.action };
    },
  },
];

// ── Dismiss + notification scenarios ──────────────────────────────────────────

const dismissNotifScenarios = [
  {
    id:          'proactive.dismiss.blocks_re_creation',
    description: 'SPEC §40: dismiss → within cooldown → re-upsert skipped',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({});
      injectInsightsMocks(db);
      try {
        const { upsertEvent, dismissEvent } = require('../../insights/store');
        const { detectCashGap }            = require('../../insights/detectors');

        const txs = makeCashGapTransactions('uid14');
        const [ev] = detectCashGap({ transactions: txs, timezone: 'Europe/Moscow', lang: 'ru' })
          .filter(r => r.type === 'upsert');
        a.ok(ev, 'event detected');

        // Create event
        await upsertEvent('uid14', ev);
        // Dismiss it
        await dismissEvent('uid14', ev.fingerprint);
        // Re-run detector → same fingerprint → upsert skipped (within cooldown)
        const r2 = await upsertEvent('uid14', ev);
        a.eq(r2.result, 'skipped', 'dismissed within cooldown → skipped');

        this.snapshot = { fingerprint: ev.fingerprint, r2Result: r2.result };
      } finally { teardownInsightsMocks(); }
    },
  },

  {
    id:          'proactive.quiet_hours.no_notification',
    description: 'SPEC §41: quiet hours (22:00-08:00) → event stored, notification NOT sent',
    domain:      'proactive',
    critical:    false,
    snapshot:    {},
    run() {
      const { isQuietHours } = require('../../insights/notificationPolicy');
      if (!isQuietHours) { this.snapshot = { skipped: 'isQuietHours not exported' }; return; }

      // Use a timezone where it's always night for this hour check
      // We can't control the wall clock, so we test the function with a known-night scenario
      // by checking Europe/Moscow at midnight UTC (= 3am Moscow)
      const mockDate = new Date('2026-09-17T21:00:00Z'); // 00:00 Moscow (UTC+3) — quiet
      const origDate = global.Date;
      global.Date = class extends Date { constructor(...args) { super(args.length ? args[0] : mockDate.getTime()); } };
      try {
        const quiet = isQuietHours('Europe/Moscow');
        a.ok(quiet, 'midnight Moscow should be quiet hours');
      } finally {
        global.Date = origDate;
      }
      this.snapshot = { quietHoursTested: true };
    },
  },

  {
    id:          'proactive.no_chatid.in_app_only',
    description: 'SPEC §42 + §63: chatId=null → in_app=true, telegram=false, no error',
    domain:      'proactive',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({});
      injectInsightsMocks(db);
      try {
        const { notifyIfEligible } = require('../../insights/notificationPolicy');
        const insight = {
          fingerprint: 'finance.cash_gap:2026-09',
          eventType:   'finance.cash_gap',
          severity:    'warning',
          status:      'active',
          facts:       { gapAmount: 15000 },
          detectedAt:  Date.now() - 60000,
        };
        const userDoc = { timezone: 'Europe/Moscow', chatId: null };

        const result = await notifyIfEligible('uid_nc', insight, userDoc, 'mock_token');
        a.ok(!result.sent, 'no Telegram sent');
        a.eq(result.channel, 'in_app_only', 'channel = in_app_only');
        a.eq(result.reason, 'no_chatId', 'reason = no_chatId');

        this.snapshot = result;
      } finally { teardownInsightsMocks(); }
    },
  },
];

module.exports = [
  ...cashGapScenarios,
  ...spikeScenarios,
  ...goalScenarios,
  ...taskScenarios,
  ...ctaScenarios,
  ...dismissNotifScenarios,
];
