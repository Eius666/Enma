'use strict';

// Fallback FX providers. Both return a single rate (no bank sample), so the
// snapshot built from them is labelled honestly — never as a "bank rate".

const { FxProviderError } = require('./bankiProvider');

const TIMEOUT_MS = 8000;

async function getJson(url, provider, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { signal: ctl.signal });
    if (!resp.ok) throw new FxProviderError(provider, 'http_error', String(resp.status));
    return await resp.json();
  } catch (err) {
    if (err instanceof FxProviderError) throw err;
    throw new FxProviderError(provider, 'network_error', err.name === 'AbortError' ? 'timeout' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// Central Bank of Russia daily official rate — stable JSON, officially published.
async function cbrRate({ currency, fetchImpl = fetch }) {
  const data = await getJson('https://www.cbr-xml-daily.ru/daily_json.js', 'cbr', fetchImpl);
  const v = data && data.Valute && data.Valute[currency];
  if (!v || !(v.Value > 0) || !(v.Nominal > 0)) throw new FxProviderError('cbr', 'unsupported_currency', currency);
  return {
    rateToRub: v.Value / v.Nominal,
    provider:  'cbr',
    source:    'official_fallback',
    rateDate:  data.Date ? String(data.Date).slice(0, 10) : null,
  };
}

// Market/aggregator mid rate (the same provider the rest of the backend
// already uses for legacy runtime conversion): units-of-currency per 1 RUB.
async function marketRate({ currency, getRates }) {
  const rates = await getRates();
  const perRub = rates && rates[currency];
  if (!(perRub > 0)) throw new FxProviderError('exchangerate-api', 'unsupported_currency', currency);
  return {
    rateToRub: 1 / perRub,
    provider:  'exchangerate-api',
    source:    'market_fallback',
    rateDate:  new Date().toISOString().slice(0, 10),
  };
}

// T-Bank public rates (unofficial endpoint, reachable from datacenters, unlike
// Banki). Rates are tiered by operation category; ATMCashoutRateGroup is the
// one that matches the cash market (USD sell ≈ Banki median, not the ~8%
// wider card-operation spread). A SINGLE bank, so it is labelled `bank_quote`,
// never `bank_average`.
const TBANK_CATEGORY = 'ATMCashoutRateGroup';

async function tbankRate({ currency, side, fetchImpl = fetch }) {
  const url = `https://api.tbank.ru/v1/currency_rates?from=${encodeURIComponent(currency)}&to=RUB`;
  const data = await getJson(url, 'tbank', fetchImpl);
  const rates = data && data.resultCode === 'OK' && data.payload && data.payload.rates;
  if (!Array.isArray(rates)) throw new FxProviderError('tbank', 'schema_mismatch', 'no rates');
  const row = rates.find(r => r.category === TBANK_CATEGORY);
  if (!row) throw new FxProviderError('tbank', 'unsupported_currency', currency);
  const { buy, sell } = row;
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || !(buy > 0) || !(sell > 0) || buy > sell) {
    throw new FxProviderError('tbank', 'schema_mismatch', 'implausible quote');
  }
  const updated = data.payload.lastUpdate && data.payload.lastUpdate.milliseconds;
  return {
    rateToRub: side === 'bank_buys' ? buy : sell,
    provider:  'tbank',
    source:    'bank_quote',
    method:    'single_quote',
    rateSide:  side,
    rateDate:  updated ? new Date(updated).toISOString().slice(0, 10) : null,
  };
}

module.exports = { cbrRate, marketRate, tbankRate };
