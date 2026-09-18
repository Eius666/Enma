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

module.exports = { cbrRate, marketRate };
