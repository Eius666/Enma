'use strict';

// DEV egress guard: every outbound Telegram/payment/social call is checked at
// one chokepoint. Pure — no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRequest, createGuardedFetch } = require('../devEgressGuard');
const { EnvIsolationError } = require('../envIsolation');

const ENV = {
  ENMA_ENV: 'dev', DEV_TELEGRAM_BOT_ID: '777', DEV_ALLOWED_CHAT_IDS: '111,-100222',
};
const tg = (method, id = '777', pre = '') => `https://api.telegram.org/${pre}bot${id}:tokenvalue/${method}`;
const json = (o) => ({ method: 'POST', body: JSON.stringify(o) });
const ev = (u, init, env = ENV) => evaluateRequest(u, init, env);

test('allowed chat via JSON body passes; other chat blocked', () => {
  assert.equal(ev(tg('sendMessage'), json({ chat_id: 111, text: 'x' })), null);
  assert.equal(ev(tg('sendMessage'), json({ chat_id: '-100222', text: 'x' })), null);
  assert.equal(ev(tg('sendMessage'), json({ chat_id: 999, text: 'x' })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
});

test('prod channel / @username targets are blocked unless allow-listed', () => {
  assert.equal(ev(tg('sendMessage'), json({ chat_id: '-1001234567890' })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  assert.equal(ev(tg('sendMessage'), json({ chat_id: '@enma_channel' })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
});

test('FormData (sendPhoto/sendDocument), URL query and form-encoded bodies are inspected', () => {
  const fd = new FormData(); fd.append('chat_id', '999');
  assert.equal(ev(tg('sendDocument'), { method: 'POST', body: fd }), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  const ok = new FormData(); ok.append('chat_id', '111');
  assert.equal(ev(tg('sendPhoto'), { method: 'POST', body: ok }), null);
  assert.equal(ev(tg('getChat') + '?chat_id=999'), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  assert.equal(ev(tg('getChat') + '?chat_id=111'), null);
  assert.equal(ev(tg('sendMessage'), { method: 'POST', body: 'chat_id=999&text=x' }), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
});

test('forwardMessage source chat and refundStarPayment user are checked too', () => {
  assert.equal(ev(tg('forwardMessage'), json({ chat_id: 111, from_chat_id: 999, message_id: 1 })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  assert.equal(ev(tg('refundStarPayment'), json({ user_id: 999, telegram_payment_charge_id: 'c' })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  assert.equal(ev(tg('refundStarPayment'), json({ user_id: 111, telegram_payment_charge_id: 'c' })), null);
});

test('a token of any other bot (e.g. production) is refused for every method', () => {
  assert.equal(ev(tg('sendMessage', '555'), json({ chat_id: 111 })), 'DEV_EGRESS_FOREIGN_BOT');
  assert.equal(ev(tg('getMe', '555')), 'DEV_EGRESS_FOREIGN_BOT');
  assert.equal(ev('https://api.telegram.org/file/bot555:t/photos/a.jpg'), 'DEV_EGRESS_FOREIGN_BOT');
  assert.equal(ev(tg('getMe', '777'), undefined, { ...ENV, DEV_TELEGRAM_BOT_ID: '' }), 'DEV_EGRESS_FOREIGN_BOT');
});

test('methods without a chat target are allowed only from the explicit list; unknown ones fail closed', () => {
  for (const m of ['getMe', 'getWebhookInfo', 'answerCallbackQuery', 'answerPreCheckoutQuery', 'createInvoiceLink', 'getStarTransactions']) {
    assert.equal(ev(tg(m), json({ any: 1 })), null, m);
  }
  assert.equal(ev(tg('sendMessage'), json({ text: 'no target' })), 'DEV_EGRESS_TELEGRAM_NO_TARGET');
  assert.equal(ev(tg('somethingNew'), json({})), 'DEV_EGRESS_TELEGRAM_NO_TARGET');
  assert.equal(ev(tg('sendDocument'), { method: 'POST', body: Buffer.from('x') }), 'DEV_EGRESS_TELEGRAM_BODY_UNINSPECTABLE');
  assert.equal(ev('https://api.telegram.org/weird'), 'DEV_EGRESS_TELEGRAM_UNPARSEABLE');
});

test('Telegram test-environment URLs (/test/) are parsed', () => {
  assert.equal(ev(tg('sendMessage', '777', ''), json({ chat_id: 111 })), null);
  assert.equal(ev('https://api.telegram.org/bot777:tok/test/sendMessage', json({ chat_id: 999 })), 'DEV_EGRESS_CHAT_NOT_ALLOWED');
});

test('Platega / TON / Threads blocked unless explicitly opted in', () => {
  assert.equal(ev('https://app.platega.io/transaction/process', { method: 'POST' }), 'DEV_EGRESS_PLATEGA_BLOCKED');
  assert.equal(ev('https://app.platega.io/x', {}, { ...ENV, DEV_PLATEGA_SANDBOX: 'true' }), null);
  assert.equal(ev('https://toncenter.com/api/v2/getTransactions'), 'DEV_EGRESS_TON_BLOCKED');
  assert.equal(ev('https://graph.threads.net/v1.0/me/threads', { method: 'POST' }), 'DEV_EGRESS_SOCIAL_BLOCKED');
});

test('unrelated hosts (AI, FX) are not affected', () => {
  assert.equal(ev('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' }), null);
  assert.equal(ev('https://api.exchangerate-api.com/v4/latest/RUB'), null);
});

test('guarded fetch rejects blocked calls without calling the real fetch', async () => {
  let called = 0;
  const g = createGuardedFetch(async () => { called++; return { ok: true }; }, ENV);
  await assert.rejects(g(tg('sendMessage'), json({ chat_id: 999 })), (e) => e instanceof EnvIsolationError && e.code === 'DEV_EGRESS_CHAT_NOT_ALLOWED');
  assert.equal(called, 0);
  assert.deepEqual(await g(tg('sendMessage'), json({ chat_id: 111 })), { ok: true });
  assert.equal(called, 1);
});

test('production: requiring the module leaves global fetch untouched', () => {
  assert.equal(global.fetch.__enmaDevGuard, undefined);
});
