'use strict';

// POST /api/telegram/send may only message the verified caller.
// No network: global fetch is replaced by a recorder.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BOT_TOKEN = '123456:TEST-TOKEN-NEVER-LOG-ME';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
delete process.env.KV_REST_API_URL; // in-memory rate limiter
delete process.env.ENMA_ENV;

const handler = require('../send');
const { createGuardedFetch } = require('../../_lib/devEgressGuard');

function signedInitData({ id = 111, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN, tamper = false } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify({ id, first_name: 'T' }),
  });
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', tamper ? hash.replace(/^./, (c) => (c === '0' ? '1' : '0')) : hash);
  return params.toString();
}

let sent, logs, realFetch, ipSeq = 0;
beforeEach(() => {
  sent = [];
  logs = [];
  realFetch = global.fetch;
  global.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ ok: true }) }; };
  for (const m of ['log', 'warn', 'error']) console[m] = (...a) => logs.push(a.map(String).join(' '));
});
afterEach(() => {
  global.fetch = realFetch;
  for (const m of ['log', 'warn', 'error']) delete console[m]; // restore prototype methods
});

async function call({ body, initData, ip } = {}) {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
  const headers = { 'x-forwarded-for': ip || `10.0.0.${++ipSeq}` };
  if (initData !== undefined) headers['x-telegram-init-data'] = initData;
  await handler({ method: 'POST', headers, body }, res);
  return res;
}

test('own chat id (number) is allowed and is what Telegram receives', async () => {
  const res = await call({ initData: signedInitData({ id: 111 }), body: { chatId: 111, text: 'hello' } });
  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, 111);
  assert.equal(sent[0].body.text, 'hello');
});

test('own chat id as a decimal string is allowed; omitted chatId defaults to the verified caller', async () => {
  assert.equal((await call({ initData: signedInitData({ id: 111 }), body: { chatId: '111', text: 'a' } })).statusCode, 200);
  assert.equal((await call({ initData: signedInitData({ id: 111 }), body: { text: 'b' } })).statusCode, 200);
  assert.deepEqual(sent.map((s) => s.body.chat_id), [111, 111]);
});

test('another user\'s chat id: 403 and Telegram is never called', async () => {
  const res = await call({ initData: signedInitData({ id: 111 }), body: { chatId: 222, text: 'other-text' } });
  assert.equal(res.statusCode, 403);
  assert.equal(sent.length, 0);
});

test('another user\'s chat id as a string: 403, no Telegram call', async () => {
  const res = await call({ initData: signedInitData({ id: 111 }), body: { chatId: '222', text: 'other-text' } });
  assert.equal(res.statusCode, 403);
  assert.equal(sent.length, 0);
});

test('non-matching chat id forms (representations, groups, usernames, arrays, objects) are all refused without a Telegram call', async () => {
  const attempts = ['0111', '+111', ' 111', '111 ', '1.11e2', '111.0', '1e2', '0x6f', '-100111', '@someone', '111,222', [111], [222], { id: 111 }, true, 111.5, -111, 0, 2 ** 60, '1111111111111111111111'];
  for (const chatId of attempts) {
    const res = await call({ initData: signedInitData({ id: 111 }), body: { chatId, text: 'x' } });
    assert.equal(res.statusCode, 403, `chatId=${JSON.stringify(chatId)}`);
  }
  assert.equal(sent.length, 0);
});

test('a body chat id equal to ANOTHER signed user\'s id cannot be used with this caller\'s initData', async () => {
  const res = await call({ initData: signedInitData({ id: 5 }), body: { chatId: 6, text: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.equal(sent.length, 0);
});

test('invalid initData (tampered hash, wrong bot token, garbage): 401, no Telegram call', async () => {
  for (const initData of [signedInitData({ tamper: true }), signedInitData({ token: '999:OTHER' }), 'garbage', 'hash=abc', 'user=%7B%7D']) {
    const res = await call({ initData, body: { chatId: 111, text: 'x' } });
    assert.equal(res.statusCode, 401, initData.slice(0, 30));
  }
  assert.equal(sent.length, 0);
});

test('expired initData (auth_date older than 24h): 401', async () => {
  const old = Math.floor(Date.now() / 1000) - 25 * 3600;
  const res = await call({ initData: signedInitData({ authDate: old }), body: { chatId: 111, text: 'x' } });
  assert.equal(res.statusCode, 401);
  assert.equal(sent.length, 0);
});

test('initData that is still fresh (23h) is accepted', async () => {
  const recent = Math.floor(Date.now() / 1000) - 23 * 3600;
  const res = await call({ initData: signedInitData({ authDate: recent }), body: { chatId: 111, text: 'x' } });
  assert.equal(res.statusCode, 200);
});

test('missing / empty initData header: 401', async () => {
  assert.equal((await call({ body: { chatId: 111, text: 'x' } })).statusCode, 401);
  assert.equal((await call({ initData: '', body: { chatId: 111, text: 'x' } })).statusCode, 401);
  assert.equal(sent.length, 0);
});

test('initData without a usable user id is refused', async () => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ first_name: 'NoId' }) });
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const res = await call({ initData: params.toString(), body: { text: 'x' } });
  assert.equal(res.statusCode, 401);
  assert.equal(sent.length, 0);
});

test('message limits: empty, whitespace, non-string and >4096 chars are refused; 4096 is allowed', async () => {
  const initData = () => signedInitData({ id: 111 });
  for (const text of ['', '   ', 123, { a: 1 }, ['x'], 'x'.repeat(4097)]) {
    const res = await call({ initData: initData(), body: { chatId: 111, text } });
    assert.equal(res.statusCode, 400, JSON.stringify(text)?.slice(0, 20));
  }
  assert.equal(sent.length, 0);
  assert.equal((await call({ initData: initData(), body: { chatId: 111, text: 'x'.repeat(4096) } })).statusCode, 200);
});

test('a normal user message is trimmed and delivered to the caller', async () => {
  const res = await call({ initData: signedInitData({ id: 42 }), body: { chatId: 42, text: '  ⏰ Reminder: call mom  ' } });
  assert.equal(res.statusCode, 200);
  assert.equal(sent[0].body.text, '⏰ Reminder: call mom');
  assert.match(sent[0].url, /^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/);
});

test('non-POST is rejected', async () => {
  const res = { statusCode: null, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  await handler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('rate limiting still applies: the 21st request from one IP within a minute is 429', async () => {
  const ip = '203.0.113.77';
  const codes = [];
  for (let i = 0; i < 21; i++) codes.push((await call({ ip, initData: signedInitData({ id: 111 }), body: { chatId: 111, text: 'x' } })).statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 20);
  assert.equal(codes[20], 429);
});

test('rate limiting is evaluated before any initData work (requests with invalid credentials are still rate limited)', async () => {
  const ip = '203.0.113.88';
  for (let i = 0; i < 20; i++) await call({ ip, initData: 'bad', body: { text: 'x' } });
  assert.equal((await call({ ip, initData: signedInitData({ id: 111 }), body: { chatId: 111, text: 'x' } })).statusCode, 429);
});

test('DEV allow-list is not weakened: in DEV the guarded fetch still blocks a caller who is not allow-listed', async () => {
  const env = { ENMA_ENV: 'dev', DEV_TELEGRAM_BOT_ID: '123456', DEV_ALLOWED_CHAT_IDS: '111' };
  const recorded = [];
  const base = async (u, i) => { recorded.push(JSON.parse(i.body)); return { status: 200, json: async () => ({ ok: true }) }; };
  global.fetch = createGuardedFetch(base, env);
  // allow-listed caller passes through the guard
  assert.equal((await call({ initData: signedInitData({ id: 111 }), body: { chatId: 111, text: 'x' } })).statusCode, 200);
  assert.equal(recorded.length, 1);
  // non-allow-listed caller messaging themselves is still stopped by the guard (handler returns its 500, nothing sent)
  const res = await call({ initData: signedInitData({ id: 999 }), body: { chatId: 999, text: 'x' } });
  assert.equal(res.statusCode, 500);
  assert.equal(recorded.length, 1);
  // and a non-matching id is refused earlier (403), never reaching the guard
  assert.equal((await call({ initData: signedInitData({ id: 111 }), body: { chatId: 999, text: 'x' } })).statusCode, 403);
  assert.equal(recorded.length, 1);
});

test('logs and responses never contain the bot token, initData or hash', async () => {
  const initData = signedInitData({ id: 111 });
  const hash = new URLSearchParams(initData).get('hash');
  const results = [];
  results.push(await call({ initData, body: { chatId: 222, text: 'secret-body' } }));
  results.push(await call({ initData: signedInitData({ tamper: true }), body: { chatId: 111, text: 'x' } }));
  results.push(await call({ initData, body: { chatId: 111, text: 'ok' } }));
  const blob = JSON.stringify(results.map((r) => r.body)) + logs.join('\n');
  for (const needle of [BOT_TOKEN, 'TEST-TOKEN-NEVER-LOG-ME', hash, 'WebAppData']) assert.ok(!blob.includes(needle), `leaked ${needle}`);
});

test('missing TELEGRAM_BOT_TOKEN fails closed (initData cannot be verified)', async () => {
  const saved = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const res = await call({ initData: signedInitData({ id: 111 }), body: { chatId: 111, text: 'x' } });
    assert.equal(res.statusCode, 401);
    assert.equal(sent.length, 0);
  } finally { process.env.TELEGRAM_BOT_TOKEN = saved; }
});
