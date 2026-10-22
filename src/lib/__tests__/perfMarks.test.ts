// node --test src/lib/__tests__/perfMarks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPerfMarksEnabled, formatPerfSummary, perfMark, getPerfEntries, requestLabel, summarizeRequests,
} from '../perfMarks.ts';
import { formatStartupRun } from '../startupRunText.ts';

test('enabled only in a development build or with the explicit build flag', () => {
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production', REACT_APP_PERF_MARKS: 'true' }), true);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production', REACT_APP_PERF_MARKS: '1' }), false);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(isPerfMarksEnabled({}), false);
});

test('disabled builds record nothing', () => {
  // This process is neither a development build nor flagged.
  perfMark('app-chunk-loaded');
  perfMark('shell-rendered');
  assert.deepEqual(getPerfEntries(), []);
});

test('the summary holds phase names and milliseconds only', () => {
  assert.equal(
    formatPerfSummary([{ phase: 'app-chunk-loaded', ms: 180 }, { phase: 'auth-resolved', ms: 420 }]),
    'app-chunk-loaded 180ms → auth-resolved 420ms',
  );
});

// ── startup diagnostics (BUG-08) ────────────────────────────────────────────


test('requests are reduced to fixed labels: no query strings, keys or ids survive', () => {
  assert.equal(requestLabel('https://telegram.org/js/telegram-web-app.js?57'), 'telegram-sdk');
  assert.equal(requestLabel('https://enma-l4lh.vercel.app/static/js/main.164a787d.js'), 'main.js');
  assert.equal(requestLabel('https://enma-l4lh.vercel.app/static/js/879.9f226445.chunk.js'), 'chunk 879');
  assert.equal(requestLabel('https://enma-l4lh.vercel.app/static/css/main.e9803783.css'), 'css');
  assert.equal(requestLabel('https://securetoken.googleapis.com/v1/token?key=AIzaSECRET'), 'auth: token refresh');
  assert.equal(requestLabel('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSECRET'), 'auth: accounts:lookup');
  assert.equal(requestLabel('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?gsessionid=abc&VER=8'), 'firestore');
  assert.equal(requestLabel('/api/auth/telegram'), 'api auth/telegram');
  assert.equal(requestLabel('/api/ai/entityCreate?uid=u1'), 'api ai/entityCreate');
  assert.equal(requestLabel('https://elsewhere.example/api/auth/telegram'), null);
  assert.equal(requestLabel('https://api.exchangerate-api.com/v4/latest/RUB'), null);
  for (const url of ['https://securetoken.googleapis.com/v1/token?key=AIzaSECRET', '/api/ai/entityCreate?uid=u1']) {
    assert.doesNotMatch(String(requestLabel(url)), /AIza|uid|key=|\?/);
  }
});

test('requests are grouped by label: first start and end, count, and cache use where known', () => {
  const out = summarizeRequests([
    { name: 'https://firestore.googleapis.com/a?x=1', startTime: 2400.4, responseEnd: 2900.6, transferSize: 900, decodedBodySize: 900 },
    { name: 'https://telegram.org/js/telegram-web-app.js', startTime: 40, responseEnd: 820, transferSize: 0, decodedBodySize: 24635 },
    { name: 'https://firestore.googleapis.com/b?x=2', startTime: 2500, responseEnd: 3100 },
    { name: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', startTime: 1500, responseEnd: 2100, transferSize: 0, decodedBodySize: 0 },
    { name: 'https://unrelated.example/x.png', startTime: 10, responseEnd: 20 },
  ]);
  assert.deepEqual(out, [
    { name: 'telegram-sdk', start: 40, end: 820, count: 1, cached: true },
    { name: 'auth: accounts:lookup', start: 1500, end: 2100, count: 1 },
    { name: 'firestore', start: 2400, end: 2901, count: 2, cached: false },
  ]);
});

test('the run text separates first screen, interface ready and data', () => {
  const text = formatStartupRun({
    recordedAt: '2026-10-22T15:10:59.729Z',
    navigationType: 'navigate',
    page: { htmlReceived: 640, bundleStarted: 1900, domReady: 1950 },
    requests: [{ name: 'telegram-sdk', start: 40, end: 820, count: 1, cached: true }],
    marks: [
      { phase: 'first-render', ms: 2300 }, { phase: 'auth-resolved', ms: 3400 }, { phase: 'shell-rendered', ms: 3450 },
      { phase: 'first-snapshot:tasks', ms: 4100 },
    ],
  }, 'ru');
  assert.match(text, /^Запуск: 2026-10-22 15:10:59 UTC \(navigate\)$/m);
  assert.match(text, /^Первый экран: 2300 мс$/m);
  assert.match(text, /^Интерфейс готов: 3450 мс$/m);
  assert.match(text, /^Задачи: 4100 мс · финансы: —$/m);
  assert.match(text, /^ {2}telegram-sdk: 40→820 \(кэш\)$/m);
});

test('production builds: the switch does not exist and a stored flag is ignored', async () => {
  const store = new Map([['enma.startupDiagnostics', '1']]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
  };
  const saved = process.env.REACT_APP_FIREBASE_PROJECT_ID;
  process.env.REACT_APP_FIREBASE_PROJECT_ID = 'enma-4ea29';
  try {
    const prod = await import('../perfMarks.ts?production-build');
    assert.equal(prod.startupDiagnosticsAvailable, false);
    assert.equal(prod.isStartupDiagnosticsOn(), false);
    prod.perfMark('app-chunk-loaded');
    assert.deepEqual(prod.getPerfEntries(), []);
    prod.setStartupDiagnostics(false);
    assert.equal(store.get('enma.startupDiagnostics'), '1', 'production never touches the flag');

    process.env.REACT_APP_FIREBASE_PROJECT_ID = 'enmadev-aa7b1';
    const dev = await import('../perfMarks.ts?dev-build');
    assert.equal(dev.startupDiagnosticsAvailable, true);
    assert.equal(dev.isStartupDiagnosticsOn(), true);
    dev.perfMark('first-render');
    assert.deepEqual(dev.getPerfEntries().map(e => e.phase), ['first-render']);
    assert.ok(store.get('enma.startupDiagnostics.lastRun'), 'the run is kept for Settings');
    dev.setStartupDiagnostics(false);
    assert.equal(store.has('enma.startupDiagnostics'), false);
    assert.equal(store.has('enma.startupDiagnostics.lastRun'), false);
  } finally {
    if (saved === undefined) delete process.env.REACT_APP_FIREBASE_PROJECT_ID; else process.env.REACT_APP_FIREBASE_PROJECT_ID = saved;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
