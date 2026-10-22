'use strict';

// scripts/dev-smoke.js against a fake fetch: it may only ever talk to the
// pinned DEV deployment, never sends credentials, never touches write
// endpoints, and never prints response bodies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSmoke, CHECKS, DEV_BASE } = require('../dev-smoke');

function fakeDeployment(overrides = {}) {
  const calls = [];
  const answers = {
    'GET /': [200, '<html><body><div id="root"></div></body></html>'],
    'GET /api/payment/version': [200, JSON.stringify({ ok: true, buildId: 'abc1234' })],
    'GET /api/telegram/cron': [401, JSON.stringify({ ok: false, description: 'Unauthorized' })],
    'POST /api/telegram/webhook': [401, JSON.stringify({ ok: false })],
    'GET /api/ai/adminStats': [405, JSON.stringify({ error: 'Method not allowed' })],
    'POST /api/ai/adminStats': [403, JSON.stringify({ error: 'forbidden' })],
    'POST /api/ai/entityCreate': [401, JSON.stringify({ error: 'Unauthorized' })],
    'POST /api/ai/noSuchAction': [404, JSON.stringify({ error: 'Unknown AI action: noSuchAction' })],
    'GET /api/insights/list': [401, JSON.stringify({ ok: false, error: 'unauthorized' })],
    'GET /api/cron/no-such-job': [404, JSON.stringify({ ok: false, error: 'unknown_cron_job' })],
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const [status, text] = answers[`${init.method} ${u.pathname}`] || [500, 'SECRET-BODY-CONTENT'];
    return { status, text: async () => text };
  };
  return { calls, fetchImpl };
}

test('a healthy DEV deployment passes every check and the build id is reported', async () => {
  const { fetchImpl } = fakeDeployment();
  const lines = [];
  const out = await runSmoke({ fetchImpl, log: l => lines.push(l) });
  assert.equal(out.ok, true, lines.join('\n'));
  assert.equal(out.buildId, 'abc1234');
  assert.equal(lines.filter(l => l.startsWith('PASS')).length, CHECKS.length);
});

test('refuses any base URL other than the pinned DEV deployment', async () => {
  for (const base of ['https://enma.su', 'https://enma.vercel.app', 'https://enma-l4lh.vercel.app/', 'http://enma-l4lh.vercel.app', 'https://evil.example']) {
    const { calls, fetchImpl } = fakeDeployment();
    await assert.rejects(runSmoke({ base, fetchImpl, log: () => {} }), /refusing to run/);
    assert.equal(calls.length, 0, base);
  }
});

test('only the pinned host, no credentials, no write or payment endpoints besides the version probe', async () => {
  const { calls, fetchImpl } = fakeDeployment();
  await runSmoke({ fetchImpl, log: () => {} });
  for (const { url, init } of calls) {
    assert.ok(url.startsWith(`${DEV_BASE}/`), url);
    const headers = Object.keys(init.headers || {}).map(h => h.toLowerCase());
    assert.ok(!headers.some(h => ['authorization', 'x-admin-key', 'x-telegram-bot-api-secret-token', 'cookie'].includes(h)), url);
    assert.ok(!/secret=|token=/.test(url), url);
    const path = new URL(url).pathname;
    assert.ok(!/\/api\/payment\/(?!version$)/.test(path), `payment route ${path}`);
    assert.ok(!/\/api\/telegram\/send|\/api\/ton\//.test(path), path);
    if (init.body !== undefined) assert.equal(init.body, '{}', `${path} sends no data`);
  }
});

test('a deployment that answers a protected route without auth fails the smoke run', async () => {
  const { fetchImpl } = fakeDeployment({ 'GET /api/telegram/cron': [200, JSON.stringify({ ok: true })] });
  const lines = [];
  const out = await runSmoke({ fetchImpl, log: l => lines.push(l) });
  assert.equal(out.ok, false);
  assert.ok(lines.some(l => l.startsWith('FAIL  cron refuses a call without the secret')));
});

test('response bodies are never printed', async () => {
  const { fetchImpl } = fakeDeployment({ 'GET /api/insights/list': [500, 'SECRET-BODY-CONTENT'] });
  const lines = [];
  await runSmoke({ fetchImpl, log: l => lines.push(l) });
  assert.ok(!lines.join('\n').includes('SECRET-BODY-CONTENT'));
});

test('a network failure is reported per check without the error message', async () => {
  const lines = [];
  const out = await runSmoke({ fetchImpl: async () => { throw new TypeError('getaddrinfo ENOTFOUND enma-l4lh.vercel.app'); }, log: l => lines.push(l) });
  assert.equal(out.ok, false);
  assert.ok(lines.every(l => !l.includes('ENOTFOUND')));
});
