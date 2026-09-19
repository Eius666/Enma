'use strict';

// ── FX service: getBankRateToRub ─────────────────────────────────────────────
//
// Chain:  Banki (aggregated bank quotes)  →  T-Bank quote  →  CBR official  →  market mid rate
//
// Rate side (client perspective — the user is the one exchanging money):
//   expense  → user must BUY foreign currency  → bank SELLS  → `bank_sells`
//   income   → user SELLS foreign currency     → bank BUYS   → `bank_buys`
//
// The snapshot is taken ONCE, when a transaction is created/edited, and stored
// on the transaction. Nothing in ENMA re-fetches it for history, rendering or
// balance calculation. The server-side cache below only lets two transactions
// created minutes apart share one snapshot.
//
// If NO provider can produce a rate this throws FxUnavailableError: callers
// must refuse to store a foreign transaction rather than invent a ruble value.

const bankiProvider = require('./bankiProvider');
const { cbrRate, marketRate, tbankRate } = require('./fallbackProviders');
const { aggregateQuotes, MIN_BANK_SAMPLE } = require('./aggregate');

const CACHE_TTL_MS = 10 * 60 * 1000;

class FxUnavailableError extends Error {
  constructor(currency, attempts) {
    super(`No reliable FX rate for ${currency}`);
    this.code = 'FX_UNAVAILABLE';
    this.currency = currency;
    this.attempts = attempts;
  }
}

function sideFor(transactionType) {
  return transactionType === 'income' ? 'bank_buys' : 'bank_sells';
}

function metric(name, fields, level = 'log') {
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  console[level](`[FX]${level === 'warn' ? '[ALERT]' : ''} metric=${name} ${kv}`);
}

// Banki blocks datacenter IPs. After BREAKER_FAILURES consecutive hard failures
// the provider is skipped for BREAKER_PAUSE_MS so every FX lookup doesn't pay
// for a request that is known to fail (worst case: the 8s timeout).
const BREAKER_FAILURES = 2;
const BREAKER_PAUSE_MS = 30 * 60 * 1000;
const HARD_FAILURES = new Set(['layout_changed', 'http_error', 'network_error']);
const BANK_SOURCES = new Set(['bank_average', 'bank_quote']);

function createFxService({
  fetchBankQuotes = bankiProvider.fetchQuotes,
  fallbackChain,
  getMarketRates,
  now = () => Date.now(),
  minSample = MIN_BANK_SAMPLE,
} = {}) {
  const cache = new Map(); // `${currency}:${side}` → { snapshot, at }
  const breaker = { failures: 0, skipUntil: 0 };

  const fallbacks = fallbackChain || [
    ({ currency, side }) => tbankRate({ currency, side }),
    ({ currency }) => cbrRate({ currency }),
    ({ currency }) => marketRate({
      currency,
      getRates: getMarketRates || (() => require('../exchangeRates').getExchangeRates()),
    }),
  ];

  async function getBankRateToRub({ currency, transactionType, timestamp } = {}) {
    if (!currency || currency === 'RUB') {
      throw new Error('getBankRateToRub is for foreign currencies only — RUB never needs FX');
    }
    const side = sideFor(transactionType);
    const key = `${currency}:${side}`;

    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return withRequestedDate(hit.snapshot, timestamp);

    const attempts = [];

    // 1) Banki bank quotes → outlier-filtered median (skipped while its breaker is open)
    if (now() < breaker.skipUntil) {
      attempts.push({ provider: 'banki', reason: 'breaker_open' });
    } else {
      try {
        const { quotes, provider, refreshedAt } = await fetchBankQuotes({ currency, side });
        const agg = aggregateQuotes(quotes, { minSample });
        if (!agg.ok) throw new bankiProvider.FxProviderError('banki', agg.reason, `n=${agg.sampleSize}`);
        const snapshot = {
          rateToRub:  Math.round(agg.rate * 10000) / 10000,
          source:     'bank_average',
          provider,
          capturedAt: new Date(now()).toISOString(),
          rateDate:   (refreshedAt || new Date(now()).toISOString()).slice(0, 10),
          sampleSize: agg.sampleSize,
          method:     agg.method,
          rateSide:   side,
        };
        metric('fx_provider_success', { provider, currency, side, sample: agg.sampleSize, method: agg.method });
        breaker.failures = 0;
        cache.set(key, { snapshot, at: now() });
        return withRequestedDate(snapshot, timestamp);
      } catch (err) {
        attempts.push({ provider: err.provider || 'banki', reason: err.reason || err.message });
        metric('fx_provider_failure', { provider: err.provider || 'banki', currency, reason: err.reason || 'error', ...(err.detail ? { detail: JSON.stringify(err.detail) } : {}) });
        if (HARD_FAILURES.has(err.reason)) {
          breaker.failures += 1;
          if (breaker.failures >= BREAKER_FAILURES) {
            breaker.skipUntil = now() + BREAKER_PAUSE_MS;
            metric('fx_provider_paused', { provider: 'banki', minutes: BREAKER_PAUSE_MS / 60000 });
          }
        }
      }
    }

    // 2) Fallbacks — single-rate providers, honestly labelled
    for (const attempt of fallbacks) {
      try {
        const r = await attempt({ currency, side });
        const snapshot = {
          rateToRub:  Math.round(r.rateToRub * 10000) / 10000,
          source:     r.source,
          provider:   r.provider,
          capturedAt: new Date(now()).toISOString(),
          rateDate:   r.rateDate,
          sampleSize: 1,
          method:     r.method || 'single_rate',
          rateSide:   r.rateSide || 'mid',
        };
        metric('fx_fallback_used', { provider: r.provider, currency, source: r.source });
        // No bank-sourced rate at all (Banki AND T-Bank down): visible in logs
        // so it is noticed before users are.
        if (!BANK_SOURCES.has(r.source)) {
          metric('fx_bank_sources_down', { currency, side, using: r.provider }, 'warn');
        }
        cache.set(key, { snapshot, at: now() });
        return withRequestedDate(snapshot, timestamp);
      } catch (err) {
        attempts.push({ provider: err.provider || 'fallback', reason: err.reason || err.message });
        metric('fx_provider_failure', { provider: err.provider || 'fallback', currency, reason: err.reason || 'error' });
      }
    }

    metric('fx_unavailable', { currency, side, attempts: attempts.map(a => `${a.provider}:${a.reason}`).join('|') }, 'warn');
    throw new FxUnavailableError(currency, attempts);
  }

  // Banki has no historical archive: a back-dated transaction gets today's
  // quote. Say so explicitly instead of pretending it's a historical rate.
  function withRequestedDate(snapshot, timestamp) {
    if (!timestamp) return snapshot;
    const requested = String(timestamp).slice(0, 10);
    return { ...snapshot, requestedDate: requested, rateMatchesRequestedDate: requested === snapshot.rateDate };
  }

  return { getBankRateToRub, _cache: cache, _breaker: breaker };
}

const defaultService = createFxService();

module.exports = {
  getBankRateToRub: (args) => defaultService.getBankRateToRub(args),
  createFxService,
  FxUnavailableError,
  MIN_BANK_SAMPLE,
};
