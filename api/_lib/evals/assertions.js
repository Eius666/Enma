'use strict';

// ── Typed assertion error ──────────────────────────────────────────────────────

class AssertionError extends Error {
  constructor(assertionType, message, expected, actual) {
    super(`[${assertionType}] ${message}`);
    this.name           = 'AssertionError';
    this.assertionType  = assertionType;
    this.expected       = expected;
    this.actual         = actual;
  }
}

function fail(type, msg, expected, actual) {
  throw new AssertionError(type, msg, expected, actual);
}

// ── Routing assertions ─────────────────────────────────────────────────────────

function skillSelected(routeResult, skillId) {
  const ids = routeResult.skills?.map(s => s.id) ?? [];
  if (!ids.includes(skillId))
    fail('skillSelected', `Expected "${skillId}" in skill list`, skillId, ids);
}

function skillNotSelected(routeResult, skillId) {
  const ids = routeResult.skills?.map(s => s.id) ?? [];
  if (ids.includes(skillId))
    fail('skillNotSelected', `Expected "${skillId}" NOT in skill list`, `!${skillId}`, ids);
}

function domainSelected(routeResult, domain) {
  const domains = routeResult.domains ?? [];
  if (!domains.includes(domain))
    fail('domainSelected', `Expected domain "${domain}" in routing result`, domain, domains);
}

function domainNotSelected(domains, domain) {
  const list = Array.isArray(domains) ? domains : (domains.domains ?? []);
  if (list.includes(domain))
    fail('domainNotSelected', `Expected domain "${domain}" NOT in list`, `!${domain}`, list);
}

function routerSource(routeResult, expectedSource) {
  if (routeResult.source !== expectedSource)
    fail('routerSource',
      `Expected source="${expectedSource}", got "${routeResult.source}"`,
      expectedSource, routeResult.source);
}

// ── Numeric assertions ─────────────────────────────────────────────────────────

function numericEquals(actual, expected, label = '') {
  if (typeof actual !== 'number' || typeof expected !== 'number')
    fail('numericEquals', `${label}: non-numeric value`, expected, actual);
  if (actual !== expected)
    fail('numericEquals', `${label}: expected ${expected}, got ${actual}`, expected, actual);
}

// tolerancePct: relative tolerance e.g. 0.001 = 0.1%
// minAbsTolerance: absolute floor in same currency units (default 1 — 1 kopek rounding OK)
function numericClose(actual, expected, label = '', tolerancePct = 0.001, minAbsTolerance = 1) {
  if (typeof actual !== 'number')
    fail('numericClose', `${label}: not a number`, expected, actual);
  const diff = Math.abs(actual - expected);
  const maxDiff = Math.max(Math.abs(expected) * tolerancePct, minAbsTolerance);
  if (diff > maxDiff)
    fail('numericClose',
      `${label}: expected ≈${expected}, got ${actual} (diff ${diff.toFixed(2)} > ${maxDiff.toFixed(2)})`,
      expected, actual);
}

// Assert a number exists and is > 0
function numericPositive(actual, label = '') {
  if (typeof actual !== 'number' || actual <= 0)
    fail('numericPositive', `${label}: expected positive number, got ${actual}`, '> 0', actual);
}

// Assert the LLM response does NOT mention a number close to `forbidden`
function numericConsistency(responseText, officialValue, label = '') {
  if (typeof responseText !== 'string') return;
  const nums = [...responseText.matchAll(/[\d\s]+(?:[,.][\d]+)?/g)]
    .map(m => parseFloat(m[0].replace(/\s/g, '').replace(',', '.')))
    .filter(n => !isNaN(n) && n > 100);
  for (const n of nums) {
    const diff = Math.abs(n - officialValue) / Math.max(officialValue, 1);
    if (diff > 0.02 && diff < 0.5)
      fail('numericConsistency',
        `${label}: response contains ${n} which diverges from official ${officialValue} (${(diff*100).toFixed(1)}%)`,
        officialValue, n);
  }
}

// ── Text assertions ────────────────────────────────────────────────────────────

function contains(text, substring, label = '') {
  if (!String(text ?? '').includes(substring))
    fail('contains', `${label}: expected text to contain "${substring}"`, substring, String(text ?? '').slice(0, 200));
}

function notContains(text, substring, label = '') {
  if (String(text ?? '').includes(substring))
    fail('notContains', `${label}: expected text NOT to contain "${substring}"`, `!${substring}`, String(text ?? '').slice(0, 200));
}

// Require specific numbers present in response text
function responseContainsNumbers(responseText, numbers = [], label = '') {
  const text = String(responseText ?? '');
  for (const num of numbers) {
    const formatted = String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const plain = String(num);
    if (!text.includes(formatted) && !text.includes(plain))
      fail('responseContainsNumbers', `${label}: expected number ${num} in response`, num, text.slice(0, 200));
  }
}

// ── Tool call assertions ───────────────────────────────────────────────────────

function toolCalled(calls, toolName, expectedCount = 1) {
  const actual = (calls ?? []).filter(c =>
    c.name === toolName || c.function?.name === toolName || c.toolName === toolName
  ).length;
  if (actual !== expectedCount)
    fail('toolCalled',
      `Expected "${toolName}" called ${expectedCount}x, got ${actual}x`,
      expectedCount, actual);
}

function toolNotCalled(calls, toolName) {
  const actual = (calls ?? []).filter(c =>
    c.name === toolName || c.function?.name === toolName || c.toolName === toolName
  ).length;
  if (actual > 0)
    fail('toolNotCalled',
      `Expected "${toolName}" NOT called, but was called ${actual}x`,
      0, actual);
}

function zeroTools(calls) {
  const count = (calls ?? []).length;
  if (count !== 0)
    fail('zeroTools', `Expected 0 tool calls, got ${count}`, 0, count);
}

// ── State assertions ───────────────────────────────────────────────────────────

function stateMatches(state, expectedPartial, label = '') {
  for (const [key, expected] of Object.entries(expectedPartial)) {
    const actual = state?.[key];
    const match  = JSON.stringify(actual) === JSON.stringify(expected);
    if (!match)
      fail('stateMatches',
        `${label}: state.${key} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        expected, actual);
  }
}

function pendingActionExists(state, toolName) {
  if (!state?.pendingAction)
    fail('pendingActionExists', `Expected pendingAction for "${toolName}", got none`, toolName, null);
  if (toolName && state.pendingAction.toolName !== toolName)
    fail('pendingActionExists',
      `Expected pendingAction.toolName="${toolName}", got "${state.pendingAction.toolName}"`,
      toolName, state.pendingAction.toolName);
}

function pendingActionCleared(state) {
  if (state?.pendingAction !== null)
    fail('pendingActionCleared', `Expected pendingAction=null, got ${JSON.stringify(state?.pendingAction)}`, null, state?.pendingAction);
}

// ── Entity / DB assertions ─────────────────────────────────────────────────────

function dbEntryExists(mockDb, path, label = '') {
  const data = mockDb._get(path);
  if (!data) fail('dbEntryExists', `${label}: expected entry at "${path}"`, true, false);
}

function dbEntryAbsent(mockDb, path, label = '') {
  const data = mockDb._get(path);
  if (data) fail('dbEntryAbsent', `${label}: expected NO entry at "${path}"`, false, true);
}

function dbCountEquals(mockDb, prefix, expected, label = '') {
  const actual = mockDb._count(prefix);
  if (actual !== expected)
    fail('dbCountEquals',
      `${label}: expected ${expected} entries under "${prefix}", got ${actual}`,
      expected, actual);
}

// ── Event / proactive assertions ───────────────────────────────────────────────

function eventCreated(results, fingerprint) {
  const found = results.find(r => r.fingerprint === fingerprint && r.type === 'upsert');
  if (!found)
    fail('eventCreated', `Expected upsert event for fingerprint "${fingerprint}"`, fingerprint,
      results.map(r => r.fingerprint));
}

function eventResolved(results, fingerprint) {
  const found = results.find(r => r.fingerprint === fingerprint && r.type === 'resolve');
  if (!found)
    fail('eventResolved', `Expected resolve event for fingerprint "${fingerprint}"`, fingerprint,
      results.map(r => r.fingerprint));
}

function noEvents(results, label = '') {
  if (results.length !== 0)
    fail('noEvents', `${label}: expected 0 events, got ${results.length}`, 0,
      results.map(r => r.fingerprint));
}

// ── Tool result assertions ─────────────────────────────────────────────────────

function toolSuccess(result, label = '') {
  if (!result?.success)
    fail('toolSuccess', `${label}: expected success=true, got ${JSON.stringify(result)}`, true, result?.success);
}

function toolFailure(result, expectedCode, label = '') {
  if (result?.success)
    fail('toolFailure', `${label}: expected failure, got success`, false, true);
  if (expectedCode && result?.errorCode !== expectedCode)
    fail('toolFailure',
      `${label}: expected errorCode="${expectedCode}", got "${result?.errorCode}"`,
      expectedCode, result?.errorCode);
}

// ── Calculation status ─────────────────────────────────────────────────────────

function calcOk(result, label = '') {
  if (result?.status !== 'ok')
    fail('calcOk', `${label}: expected status=ok, got ${result?.status}`, 'ok', result?.status);
}

function calcInsufficient(result, label = '') {
  if (result?.status !== 'insufficient_data')
    fail('calcInsufficient', `${label}: expected insufficient_data`, 'insufficient_data', result?.status);
}

// ── Generic helpers ────────────────────────────────────────────────────────────

function ok(value, message = 'Expected truthy') {
  if (!value) fail('ok', message, true, value);
}

function eq(actual, expected, label = '') {
  if (actual !== expected)
    fail('eq', `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, expected, actual);
}

module.exports = {
  AssertionError,
  // Routing
  skillSelected, skillNotSelected, domainSelected, domainNotSelected, routerSource,
  // Numeric
  numericEquals, numericClose, numericPositive, numericConsistency,
  // Text
  contains, notContains, responseContainsNumbers,
  // Tools
  toolCalled, toolNotCalled, zeroTools,
  // State
  stateMatches, pendingActionExists, pendingActionCleared,
  // DB
  dbEntryExists, dbEntryAbsent, dbCountEquals,
  // Events
  eventCreated, eventResolved, noEvents,
  // Tool results
  toolSuccess, toolFailure,
  // Calc
  calcOk, calcInsufficient,
  // Generic
  ok, eq,
};
