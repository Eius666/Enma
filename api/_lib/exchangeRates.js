'use strict';

const { DEFAULT_CURRENCY } = require('./config');

// Process-lifetime in-memory cache — best effort only. Backend aggregation must
// stay correct even when this is unavailable (see getExchangeRates callers:
// same-currency transactions never need it, so an offline FX API never breaks
// a RUB-only user's balance).
let cache = null; // { rates, fetchedAt }
const TTL_MS = 60 * 60 * 1000;

async function getExchangeRates() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.rates;
  try {
    const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${DEFAULT_CURRENCY}`);
    if (!resp.ok) throw new Error(`FX_HTTP_${resp.status}`);
    const data = await resp.json();
    if (!data || typeof data.rates !== 'object') throw new Error('FX_BAD_PAYLOAD');
    cache = { rates: data.rates, fetchedAt: Date.now() };
    return cache.rates;
  } catch (err) {
    console.error('[FX_RATES] fetch failed reason=%s', err.message);
    return cache ? cache.rates : null; // serve stale cache if we have one, else give up
  }
}

module.exports = { getExchangeRates };
