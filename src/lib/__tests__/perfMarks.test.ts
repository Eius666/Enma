// node --test src/lib/__tests__/perfMarks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPerfMarksEnabled, formatPerfSummary, perfMark, getPerfEntries, requestLabel, summarizeRequests, classifySession,
  startupTraceId,
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
  // Firebase Auth's popup/redirect helper, so a start that still loads it shows it.
  assert.equal(requestLabel('https://apis.google.com/js/api.js?onload=__iframefcb123'), 'auth: gapi');
  assert.equal(requestLabel('https://apis.google.com/_/scs/abc-static/_/js/k=gapi.lb.ru.x/m=gapi_iframes'), 'auth: gapi');
  assert.equal(requestLabel('https://enmadev-aa7b1.firebaseapp.com/__/auth/iframe?apiKey=AIzaSECRET&appName=%5BDEFAULT%5D'), 'auth: iframe');
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
    page: { htmlReceived: 640, bundleStarted: 1900, domReady: 1950, dns: 12, connect: 230, firstByte: 520, firstContentfulPaint: 2310, authInit: 1960 },
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
  assert.match(text, /^ {2}DNS: 12 мс · соединение: 230 мс · первый байт: 520 мс$/m);
  assert.match(text, /^ {2}первая отрисовка: 2310 мс · старт Auth: 1960 мс$/m);
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

// ── sign-in breakdown (slow Telegram sign-in investigation) ─────────────────

test('sign-in requests are listed one by one: the first and the second accounts:lookup are separate steps', () => {
  const out = summarizeRequests([
    { name: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', startTime: 300, responseEnd: 2850 },
    { name: '/api/auth/telegram', startTime: 2900, responseEnd: 6264 },
    { name: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=k', startTime: 6300, responseEnd: 6800 },
    { name: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', startTime: 6800, responseEnd: 7273 },
    { name: 'https://firestore.googleapis.com/a', startTime: 7400, responseEnd: 7600 },
    { name: 'https://firestore.googleapis.com/b', startTime: 7410, responseEnd: 7700 },
  ]);
  assert.deepEqual(out.map(r => [r.name, r.start, r.end, r.count]), [
    ['auth: accounts:lookup', 300, 2850, 1],
    ['api auth/telegram', 2900, 6264, 1],
    ['auth: accounts:signInWithCustomToken', 6300, 6800, 1],
    ['auth: accounts:lookup #2', 6800, 7273, 1],
    ['firestore', 7400, 7600, 2],
  ]);
});

test('the server\'s Server-Timing phases are kept for API calls, names and ms only', () => {
  const [r] = summarizeRequests([{
    name: '/api/auth/telegram', startTime: 10, responseEnd: 500,
    serverTiming: [{ name: 'links', duration: 98.4 }, { name: 'total', duration: 201.6 }, { name: 'bad name; x', duration: 1 }],
  }]);
  assert.deepEqual(r.serverTiming, [{ name: 'links', dur: 98 }, { name: 'total', dur: 202 }]);
});

test('session at start: restored, rejected after Firebase checked a saved one, or none saved', () => {
  const lookup = { name: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k', startTime: 300, responseEnd: 2850 };
  const refresh = { name: 'https://securetoken.googleapis.com/v1/token?key=k', startTime: 300, responseEnd: 900 };
  assert.equal(classifySession(true, [lookup], 3000), 'restored');
  assert.equal(classifySession(false, [lookup], 3000), 'rejected');
  assert.equal(classifySession(false, [refresh], 3000), 'rejected');
  assert.equal(classifySession(false, [], 3000), 'none');
  // A lookup that started after the report (the one after sign-in) does not count.
  assert.equal(classifySession(false, [{ ...lookup, startTime: 3500 }], 3000), 'none');
});

test('the run text shows the session outcome, the trace id and the server phases', () => {
  const text = formatStartupRun({
    recordedAt: '2026-10-23T15:10:59.729Z', navigationType: 'navigate', page: {},
    requests: [{ name: 'api auth/telegram', start: 2900, end: 6264, count: 1, serverTiming: [{ name: 'links', dur: 98 }, { name: 'total', dur: 202 }] }],
    marks: [], auth: { session: 'rejected', persistence: 'LOCAL', indexedDbPresent: true }, traceId: '0123456789abcdef',
  }, 'ru');
  assert.match(text, /^Сессия: сохранённая отклонена Firebase · хранилище: LOCAL$/m);
  assert.match(text, /^trace: 0123456789abcdef$/m);
  assert.match(text, /^ {4}сервер: links 98 · total 202$/m);
});

test('no trace id while diagnostics are off', () => {
  assert.equal(startupTraceId(), null);
});
