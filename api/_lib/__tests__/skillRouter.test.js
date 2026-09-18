'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { routeSkill, mergeContextDomains, composeSystemPrompt, VALID_SKILL_IDS } = require('../skillRouter');
const { SKILL_CALCULATIONS } = require('../finance/engine');

// ── Helpers ───────────────────────────────────────────────────────────────────

function route(message, history = []) {
  return routeSkill({ message, history, domains: [] });
}

function firstSkillId(result) {
  return result.skills[0]?.id ?? null;
}

// ── Trigger routing tests ─────────────────────────────────────────────────────

test('router: affordability — "Могу ли я купить ноутбук за 150 000 ₽"', () => {
  const r = route('Могу ли я купить ноутбук за 150 000 ₽?');
  assert.ok(r.skills.some(s => s.id === 'finance.affordability'));
});

test('router: budget — "Составь мне бюджет на следующий месяц"', () => {
  const r = route('Составь мне бюджет на следующий месяц');
  assert.ok(r.skills.some(s => s.id === 'finance.budget'));
});

test('router: debt — "Какой кредит мне гасить первым?"', () => {
  const r = route('Какой кредит мне гасить первым?');
  assert.ok(r.skills.some(s => s.id === 'finance.debt'));
});

test('router: cashflow — "Хватит ли мне денег до зарплаты?"', () => {
  const r = route('Хватит ли мне денег до зарплаты?');
  assert.ok(r.skills.some(s => s.id === 'finance.cashflow'));
});

test('router: month_review — "Разбери мои расходы за август"', () => {
  const r = route('Разбери мои расходы за август');
  assert.ok(r.skills.some(s => s.id === 'finance.month_review'));
});

test('router: stress_test — "Что будет, если я останусь без зарплаты на 4 месяца?"', () => {
  const r = route('Что будет если я останусь без зарплаты на 4 месяца?');
  assert.ok(r.skills.some(s => s.id === 'finance.stress_test'));
});

test('router: what_if — "А если я буду откладывать на 15 000 ₽ больше?"', () => {
  const r = route('А если я буду откладывать на 15 000 ₽ больше?');
  assert.ok(r.skills.some(s => s.id === 'finance.what_if'));
});

test('router: salary_distribution — "Распредели мою следующую зарплату"', () => {
  const r = route('Распредели мою следующую зарплату');
  assert.ok(r.skills.some(s => s.id === 'finance.salary_distribution'));
});

test('router: payment_calendar — "Какие крупные платежи ждут меня до конца месяца?"', () => {
  const r = route('Какие крупные платежи ждут меня до конца месяца?');
  assert.ok(r.skills.some(s => s.id === 'finance.payment_calendar'));
});

test('router: leaks — "Куда уходят деньги?"', () => {
  const r = route('Куда уходят деньги?');
  assert.ok(r.skills.some(s => s.id === 'finance.leaks'));
});

test('router: goal — "Когда я накоплю на отпуск?"', () => {
  const r = route('Когда я накоплю на отпуск?');
  assert.ok(r.skills.some(s => s.id === 'finance.goal'));
});

test('router: full_audit — "Полный финансовый аудит"', () => {
  const r = route('Полный финансовый аудит');
  assert.ok(r.skills.some(s => s.id === 'finance.full_audit'));
});

// ── full_audit absorbs other skills ──────────────────────────────────────────

test('router: full_audit absorbs leaks and budget triggers', () => {
  // A message that could match both full_audit and leaks
  const r = route('Полный финансовый аудит — куда уходят деньги?');
  assert.ok(r.skills.some(s => s.id === 'finance.full_audit'), 'should have full_audit');
  assert.ok(!r.skills.some(s => s.id === 'finance.leaks'), 'should NOT have leaks separately');
  assert.ok(!r.skills.some(s => s.id === 'finance.budget'), 'should NOT have budget separately');
});

// ── Non-finance messages should not trigger finance skills ────────────────────

test('router: no finance skill for non-financial message', () => {
  const r = route('Добавь задачу на завтра: купить молоко');
  assert.ok(!r.skills.some(s => s.id.startsWith('finance.')));
});

test('router: no finance skill for generic greeting', () => {
  const r = route('Привет, как дела?');
  assert.ok(!r.skills.some(s => s.id.startsWith('finance.')));
});

// ── Cashflow vs Affordability disambiguation ──────────────────────────────────

test('router: cashflow, not affordability, for "хватит до зарплаты"', () => {
  const r = route('Хватит ли мне денег до зарплаты?');
  assert.ok(r.skills.some(s => s.id === 'finance.cashflow'));
  assert.ok(!r.skills.some(s => s.id === 'finance.affordability'));
});

test('router: affordability, not cashflow, for "могу ли купить"', () => {
  const r = route('Могу ли я купить AirPods за 25 000?');
  assert.ok(r.skills.some(s => s.id === 'finance.affordability'));
  assert.ok(!r.skills.some(s => s.id === 'finance.cashflow'));
});

// ── VALID_SKILL_IDS contains all finance skills ───────────────────────────────

test('VALID_SKILL_IDS contains all 12 finance skills', () => {
  const expected = [
    'finance.full_audit', 'finance.affordability', 'finance.leaks', 'finance.goal',
    'finance.budget', 'finance.debt', 'finance.cashflow', 'finance.month_review',
    'finance.stress_test', 'finance.what_if', 'finance.salary_distribution',
    'finance.payment_calendar',
  ];
  for (const id of expected) {
    assert.ok(VALID_SKILL_IDS.has(id), `Missing skill: ${id}`);
  }
});

// ── SKILL_CALCULATIONS coverage ───────────────────────────────────────────────

test('SKILL_CALCULATIONS covers all 12 finance skills', () => {
  const financeSkills = [...VALID_SKILL_IDS].filter(id => id.startsWith('finance.'));
  for (const id of financeSkills) {
    assert.ok(
      SKILL_CALCULATIONS[id] !== undefined,
      `Missing SKILL_CALCULATIONS entry for ${id}`
    );
    assert.ok(
      Array.isArray(SKILL_CALCULATIONS[id]) && SKILL_CALCULATIONS[id].length > 0,
      `Empty calculations for ${id}`
    );
  }
});

// ── mergeContextDomains ───────────────────────────────────────────────────────

test('mergeContextDomains: skill requiredContext is added to router domains', () => {
  const { skills } = routeSkill({ message: 'Хватит ли денег до зарплаты?', history: [], domains: ['finance'] });
  const merged = mergeContextDomains(['finance'], skills);
  assert.ok(merged.includes('finance'));
  // cashflow skill also needs reminders
  assert.ok(merged.includes('reminders'));
});

// ── composeSystemPrompt ───────────────────────────────────────────────────────

test('composeSystemPrompt: includes skill prompt when skill matched', () => {
  const { skills } = routeSkill({ message: 'Куда уходят деньги?', history: [], domains: [] });
  const prompt = composeSystemPrompt(skills, null, null);
  assert.ok(prompt.includes('ПОИСК УТЕЧЕК БЮДЖЕТА'));
});

test('composeSystemPrompt: appends calculatedMetrics last', () => {
  const { skills } = routeSkill({ message: 'Куда уходят деньги?', history: [], domains: [] });
  const metrics = '[CALCULATED FINANCIAL METRICS]\ntest';
  const prompt   = composeSystemPrompt(skills, 'user context', metrics);
  assert.ok(prompt.endsWith(metrics));
});

test('composeSystemPrompt: metrics block absent when calculatedMetrics is null', () => {
  // CORE_PROMPT itself references [CALCULATED FINANCIAL METRICS] as a condition,
  // but the actual data block only appears when calculatedMetrics is non-null.
  const { skills } = routeSkill({ message: 'Куда уходят деньги?', history: [], domains: [] });
  const promptWithout = composeSystemPrompt(skills, null, null);
  const promptWith    = composeSystemPrompt(skills, null, '[CALCULATED FINANCIAL METRICS]\ntest data');
  // With metrics the string appears at least twice (CORE_PROMPT mention + data block)
  const countWith    = (promptWith.match(/\[CALCULATED FINANCIAL METRICS\]/g) || []).length;
  const countWithout = (promptWithout.match(/\[CALCULATED FINANCIAL METRICS\]/g) || []).length;
  assert.ok(countWith > countWithout, 'metrics block adds additional occurrence');
});

console.log('\n✅ Skill router tests completed');
