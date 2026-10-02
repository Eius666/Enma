'use strict';

// Covers the Telegram Stars pricing fix: Pro and Premium previously both
// showed a flat 1000 XTR despite having different real USD prices. Stars
// price must now be derived from each plan's canonical USD price via
// Telegram's DEVELOPER reward rate ($0.013/Star — not retail Stars pricing,
// which varies by region/platform/VAT), rounded UP to the nearest 10 XTR.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { usdToStars, starsPriceFor, isValidStarsPlan, PLAN_USD_PRICES, TELEGRAM_STAR_REWARD_USD } = require('../config');

test('TELEGRAM_STAR_REWARD_USD is the developer reward rate, 0.013', () => {
  assert.equal(TELEGRAM_STAR_REWARD_USD, 0.013);
});

test('PLAN_USD_PRICES mirrors the real canonical prices (PLANS in src/subscription.ts)', () => {
  assert.equal(PLAN_USD_PRICES.pro.month, 8);
  assert.equal(PLAN_USD_PRICES.premium.month, 11);
});

test('usdToStars: $8 → 620 Stars (the worked example from the audit)', () => {
  // 8 / 0.013 = 615.384615... ; /10 = 61.5384615... ; ceil = 62 ; *10 = 620
  assert.equal(usdToStars(8), 620);
});

test('usdToStars: $11 (Premium) → 850 Stars, computed the same way, not invented', () => {
  // 11 / 0.013 = 846.153846... ; /10 = 84.6153846... ; ceil = 85 ; *10 = 850
  assert.equal(usdToStars(11), 850);
});

test('usdToStars: Pro and Premium never produce the same price', () => {
  assert.notEqual(usdToStars(PLAN_USD_PRICES.pro.month), usdToStars(PLAN_USD_PRICES.premium.month));
});

test('usdToStars: result is always a multiple of 10', () => {
  for (const usd of [1, 2.5, 7, 8, 11, 19.99, 50, 123.45]) {
    assert.equal(usdToStars(usd) % 10, 0, `usdToStars(${usd}) must be a multiple of 10`);
  }
});

test('usdToStars: always rounds UP — the Stars value is never cheaper than the real USD price', () => {
  for (const usd of [1, 8, 11, 19.99, 50]) {
    const stars = usdToStars(usd);
    const starsUsdEquivalent = stars * TELEGRAM_STAR_REWARD_USD;
    assert.ok(starsUsdEquivalent >= usd - 1e-9, `usdToStars(${usd})=${stars} must be worth >= $${usd}`);
  }
});

test('usdToStars: rejects zero, negative and non-finite input — never silently returns a bad price', () => {
  assert.throws(() => usdToStars(0),    RangeError);
  assert.throws(() => usdToStars(-1),   RangeError);
  assert.throws(() => usdToStars(NaN),  RangeError);
  assert.throws(() => usdToStars(Infinity), RangeError);
  assert.throws(() => usdToStars(undefined), RangeError);
});

test('starsPriceFor: pro/month=620, premium/month=850, computed via usdToStars — not hardcoded duplicates', () => {
  assert.equal(starsPriceFor('pro', 'month'), usdToStars(PLAN_USD_PRICES.pro.month));
  assert.equal(starsPriceFor('premium', 'month'), usdToStars(PLAN_USD_PRICES.premium.month));
  assert.equal(starsPriceFor('pro', 'month'), 620);
  assert.equal(starsPriceFor('premium', 'month'), 850);
});

test('starsPriceFor: no yearly Stars product exists — year returns null for both plans, not an invented price', () => {
  assert.equal(starsPriceFor('pro', 'year'), null);
  assert.equal(starsPriceFor('premium', 'year'), null);
});

test('isValidStarsPlan: true for pro/month and premium/month, false otherwise', () => {
  assert.equal(isValidStarsPlan('pro', 'month'), true);
  assert.equal(isValidStarsPlan('premium', 'month'), true);
  assert.equal(isValidStarsPlan('pro', 'year'), false);
  assert.equal(isValidStarsPlan('premium', 'year'), false);
  assert.equal(isValidStarsPlan('free', 'month'), false);
});
