'use strict';

// ── Prompt & component version registry ────────────────────────────────────────
// Lets eval reports show which prompt/calculator version was running at failure time.
// Bump the version string when the prompt or formula changes.

const VERSIONS = {
  // System prompts
  core:    'v4',

  // Skill prompts (bump when prompt text changes)
  skills: {
    'finance.full_audit':          'v2',
    'finance.affordability':       'v2',
    'finance.leaks':               'v2',
    'finance.goal':                'v2',
    'finance.budget':              'v2',
    'finance.cashflow':            'v2',
    'finance.stress_test':         'v2',
    'finance.month_review':        'v2',
    'finance.what_if':             'v2',
    'finance.debt':                'v2',
    'finance.salary_distribution': 'v2',
    'finance.payment_calendar':    'v2',
    'tasks.plan_day':              'v1',
    'tasks.prioritize':            'v1',
  },

  // Calculation engine functions (bump when formula changes)
  calculators: {
    affordability: 'v2',
    cashflow:      'v2',
    goals:         'v2',
    metrics:       'v2',
    leaks:         'v2',
    monthReview:   'v2',
    stressTest:    'v1',
    scenarios:     'v1',
    debt:          'v1',
  },

  // Proactive detectors (matches detectorVersion field in config.js)
  detectors: {
    'finance.cash_gap':          '1.0',
    'finance.payment_cluster':   '1.0',
    'finance.category_spike':    '1.0',
    'finance.goal_off_track':    '1.0',
    'tasks.overdue':             '1.0',
    'system.month_review_ready': '1.0',
  },

  // Routers
  contextRouter:     'v3',
  skillRouter:       'v3',
  conversationState: 'v2',
};

module.exports = { VERSIONS };
