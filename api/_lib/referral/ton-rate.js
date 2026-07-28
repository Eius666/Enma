'use strict';

// In-process cache — short-lived in serverless, but avoids hammer CoinGecko on warm containers.
let _cache = { rate: null, fetchedAt: 0 };
const CACHE_TTL_MS  = 5 * 60 * 1000;  // 5 minutes
const FALLBACK_RATE = 3.0;             // TON/USD safety fallback

async function getTonRateUsd() {
  const now = Date.now();
  if (_cache.rate && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.rate;
  }

  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!resp.ok) throw new Error('CoinGecko ' + resp.status);
    const data = await resp.json();
    const rate = data?.['the-open-network']?.usd;
    if (typeof rate !== 'number' || rate <= 0) throw new Error('Invalid CoinGecko response');
    _cache = { rate, fetchedAt: now };
    return rate;
  } catch (err) {
    console.error('[ton-rate] fetch failed:', err.message, '— using fallback', _cache.rate || FALLBACK_RATE);
    return _cache.rate || FALLBACK_RATE;
  }
}

module.exports = { getTonRateUsd };
