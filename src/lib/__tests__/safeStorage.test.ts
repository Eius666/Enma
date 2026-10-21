import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeGetItem, safeSetItem, safeRemoveItem, safeReadJson, safeWriteJson,
  __resetSafeStorageReportsForTests,
} from '../safeStorage.ts';

// A tiny localStorage stand-in whose behaviour each test can break.
function makeStore(overrides: Partial<Storage> = {}) {
  const data = new Map<string, string>();
  const store = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
    ...overrides,
  } as Storage;
  return { store, data };
}

const g = globalThis as Record<string, unknown>;
let warnings: string[] = [];
let origWarn: typeof console.warn;

function install(store: Storage | (() => Storage)) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: typeof store === 'function' ? store : () => store,
  });
}

beforeEach(() => {
  warnings = [];
  origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  __resetSafeStorageReportsForTests();
});
afterEach(() => {
  console.warn = origWarn;
  delete g.localStorage;
});

const domError = (name: string, message = 'secret message with user data') => {
  const e = new Error(message);
  e.name = name;
  return e;
};

test('normal write and read round-trip, with the exact key and JSON format used before', () => {
  const { store, data } = makeStore();
  install(store);
  assert.equal(safeWriteJson('enma.u1.tasks', [{ id: 1, title: 'x' }]), true);
  assert.equal(data.get('enma.u1.tasks'), JSON.stringify([{ id: 1, title: 'x' }]));
  assert.deepEqual(safeReadJson('enma.u1.tasks', []), [{ id: 1, title: 'x' }]);
  assert.equal(safeSetItem('enma.theme', 'dark'), true);
  assert.equal(safeGetItem('enma.theme'), 'dark');
  assert.equal(safeRemoveItem('enma.theme'), true);
  assert.equal(safeGetItem('enma.theme'), null);
  assert.equal(warnings.length, 0);
});

test('existing data written by the previous implementation is read unchanged', () => {
  const { store } = makeStore();
  store.setItem('enma.u1.profile', JSON.stringify({ displayName: 'Anna' }));
  store.setItem('enma.agreedToTerms', 'true');
  install(store);
  assert.deepEqual(safeReadJson('enma.u1.profile', null), { displayName: 'Anna' });
  assert.equal(safeGetItem('enma.agreedToTerms'), 'true');
});

test('missing key and empty string yield the fallback', () => {
  install(makeStore().store);
  assert.deepEqual(safeReadJson('nope', ['fallback']), ['fallback']);
  const { store } = makeStore();
  store.setItem('empty', '');
  install(store);
  assert.deepEqual(safeReadJson('empty', 7), 7);
});

test('localStorage property itself throws (SecurityError): nothing throws, reads are null, writes are false', () => {
  install(() => { throw domError('SecurityError'); });
  assert.equal(safeGetItem('k'), null);
  assert.equal(safeSetItem('k', 'v'), false);
  assert.equal(safeRemoveItem('k'), false);
  assert.deepEqual(safeReadJson('k', 'fb'), 'fb');
  assert.equal(safeWriteJson('k', { a: 1 }), false);
  assert.ok(warnings.some(w => w.includes('unavailable') && w.includes('SecurityError')));
});

test('localStorage is undefined (not available at all): graceful', () => {
  delete g.localStorage;
  assert.equal(safeGetItem('k'), null);
  assert.equal(safeSetItem('k', 'v'), false);
  assert.deepEqual(safeReadJson('k', 1), 1);
});

test('getItem / setItem / removeItem methods throw: handled', () => {
  install(makeStore({
    getItem: () => { throw domError('SecurityError'); },
    setItem: () => { throw domError('SecurityError'); },
    removeItem: () => { throw domError('SecurityError'); },
  }).store);
  assert.equal(safeGetItem('k'), null);
  assert.equal(safeSetItem('k', 'v'), false);
  assert.equal(safeRemoveItem('k'), false);
  assert.equal(safeWriteJson('k', 1), false);
});

test('QuotaExceededError on write: returns false, existing data untouched, nothing removed', () => {
  const { store, data } = makeStore();
  store.setItem('enma.u1.notes', JSON.stringify(['old']));
  const removeCalls: string[] = [];
  let clearCalls = 0;
  Object.assign(store, {
    setItem: () => { throw domError('QuotaExceededError'); },
    removeItem: (k: string) => { removeCalls.push(k); },
    clear: () => { clearCalls++; },
  });
  install(store);
  assert.equal(safeWriteJson('enma.u1.notes', ['new']), false);
  assert.equal(data.get('enma.u1.notes'), JSON.stringify(['old']));
  assert.deepEqual(removeCalls, []);
  assert.equal(clearCalls, 0);
  assert.ok(warnings.some(w => w.includes('write') && w.includes('QuotaExceededError')));
});

test('corrupted JSON returns the fallback and is NOT deleted or overwritten', () => {
  const { store, data } = makeStore();
  store.setItem('enma.u1.tasks', '{not json');
  install(store);
  assert.deepEqual(safeReadJson('enma.u1.tasks', []), []);
  assert.equal(data.get('enma.u1.tasks'), '{not json');
  assert.ok(warnings.some(w => w.includes('parse') && w.includes('SyntaxError')));
});

test('serialization failures (circular, BigInt, undefined) return false and write nothing', () => {
  const { store, data } = makeStore();
  install(store);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(safeWriteJson('a', circular), false);
  assert.equal(safeWriteJson('b', { n: BigInt(1) }), false);
  assert.equal(safeWriteJson('c', undefined), false);
  assert.equal(data.size, 0);
});

test('diagnostics never contain keys (they embed user ids), values or error messages', () => {
  install(makeStore({
    setItem: () => { throw domError('QuotaExceededError', 'enma.user-123.notes: private note text'); },
    getItem: () => 'not json {',
  }).store);
  safeWriteJson('enma.user-123.notes', ['private note text']);
  safeReadJson('enma.user-123.tasks', []);
  const all = warnings.join('\n');
  assert.ok(warnings.length >= 2);
  for (const needle of ['user-123', 'private note text', 'enma.', 'not json']) {
    assert.ok(!all.includes(needle), `diagnostic leaked: ${needle}`);
  }
});

test('the same failure is reported once per session (effects fire often)', () => {
  install(makeStore({ setItem: () => { throw domError('QuotaExceededError'); } }).store);
  for (let i = 0; i < 50; i++) safeWriteJson('k', i);
  assert.equal(warnings.length, 1);
});

test('a throwing console.warn cannot break callers', () => {
  console.warn = () => { throw new Error('console broken'); };
  install(makeStore({ setItem: () => { throw domError('QuotaExceededError'); } }).store);
  assert.doesNotThrow(() => safeWriteJson('k', 1));
});
