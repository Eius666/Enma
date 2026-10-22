// Finance rules that exist twice — once on the server (api/_lib) and once as
// the client's display copy (src/utils) — run over the same inputs. Both copies
// say "change one only together with the other"; this makes that checkable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as clientResolve from '../../../../src/utils/resolveLegacyCurrency.ts';
import * as clientConvert from '../../../../src/utils/convertCurrency.ts';

const require = createRequire(import.meta.url);
const serverResolve = require('../resolveLegacyCurrency.js');
const serverConvert = require('../../convertCurrency.js');

const BOUNDARY = Date.parse('2026-09-18T09:12:56Z');
const ts = (ms) => ({ toMillis: () => ms });
const dateObj = (ms) => ({ toDate: () => new Date(ms) });

const TRANSACTIONS = [
  ['explicit currency', { currency: 'EUR', source: 'web-app' }],
  ['explicit currency without source', { currency: 'USD' }],
  ['legacy Telegram bot record', { source: 'telegram-bot', createdAt: ts(BOUNDARY + 1e9) }],
  ['AI chat record without currency', { source: 'ai-chat' }],
  ['web record before the boundary (createdAt Timestamp)', { createdAt: ts(BOUNDARY - 1) }],
  ['web record exactly at the boundary', { createdAt: ts(BOUNDARY) }],
  ['web record after the boundary', { createdAt: ts(BOUNDARY + 60_000) }],
  ['web record with a toDate-only createdAt', { createdAt: dateObj(BOUNDARY - 86400000) }],
  ['web record with a numeric createdAt', { createdAt: BOUNDARY - 5 }],
  ['web record dated only by its date field', { date: '2026-09-01' }],
  ['web record with an unparsable date', { date: 'yesterday' }],
  ['web record without any timestamp', {}],
  ['unknown source', { source: 'import-script', createdAt: ts(BOUNDARY - 1) }],
  ['web-app source without currency', { source: 'web-app', createdAt: ts(BOUNDARY - 1) }],
  ['empty currency string', { currency: '', createdAt: ts(BOUNDARY - 1) }],
];

for (const [name, tx] of TRANSACTIONS) {
  test(`legacy currency resolution agrees: ${name}`, () => {
    assert.deepEqual(clientResolve.resolveTransactionCurrency(tx), serverResolve.resolveTransactionCurrency(tx));
  });
}

test('the legacy boundary constant is identical', () => {
  assert.equal(clientResolve.WEB_USD_BUG_END, serverResolve.WEB_USD_BUG_END);
});

const RATES = { RUB: 1, USD: 0.0125, EUR: 0.0107, KZT: 5.9 };
const CONVERSIONS = [
  [100, 'RUB', 'RUB', RATES],
  [100, 'USD', 'RUB', RATES],
  [8000, 'RUB', 'USD', RATES],
  [50, 'EUR', 'USD', RATES],
  [1000, 'KZT', 'EUR', RATES],
  [10, 'GBP', 'RUB', RATES], // unknown currency: treated as rate 1 on both sides
  [0, 'USD', 'EUR', RATES],
  [-25, 'USD', 'RUB', RATES],
];
for (const [amount, from, to, rates] of CONVERSIONS) {
  test(`currency conversion agrees: ${amount} ${from} → ${to}`, () => {
    assert.equal(clientConvert.convertCurrency(amount, from, to, rates), serverConvert.convertCurrency(amount, from, to, rates));
  });
}
