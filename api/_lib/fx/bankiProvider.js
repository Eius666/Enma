'use strict';

// ── BankiProvider — ISOLATED adapter for Banki.ru cash exchange quotes ───────
//
// Investigation result (see report): Banki.ru has NO official public API and
// no documented machine endpoint. The rate list is only available inside the
// server-rendered page state (`data-module-options` JSON of the cash-rate
// page). This adapter reads that embedded JSON — NOT DOM selectors — and is
// the ONLY file that knows anything about Banki's markup. Everything else in
// ENMA depends on the FxProvider contract:
//
//   fetchQuotes({ currency, side }) → { quotes:number[], provider, refreshedAt, pageUrl }
//   throws FxProviderError on any failure (network, block, layout change,
//   schema mismatch) — callers fall back to the next provider.
//
// Banki field semantics (verified on live data, bank perspective):
//   exchange.buy  = price at which the BANK BUYS foreign currency from a client
//   exchange.sale = price at which the BANK SELLS foreign currency to a client
// A normal row has buy <= sale; rows violating that are inverted/garbage and
// are dropped before aggregation.

const REGION = 'moskva';
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (compatible; ENMA-FX/1.0; +https://enma-silk.vercel.app)';
const SUPPORTED = new Set(['USD', 'EUR', 'CNY', 'GBP', 'KZT', 'TRY', 'AED', 'JPY', 'CHF']);
const MAX_AGE_MS = 48 * 3600 * 1000;

class FxProviderError extends Error {
  constructor(provider, reason, detail) {
    super(`${provider}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.provider = provider;
    this.reason = reason;
    this.detail = detail || null;
  }
}

// Safe, content-free summary of a page we could not parse (public page, no
// user data): enough to tell "challenge/captcha page" from "layout changed".
function describeResponse(resp, html) {
  const title = (html.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || '';
  const lower = html.toLowerCase();
  const markers = ['captcha', 'antibot', 'access denied', 'forbidden', 'cloudflare', 'ddos', 'проверк', 'robot']
    .filter(m => lower.includes(m));
  return `status=${resp.status} type=${resp.headers && resp.headers.get ? resp.headers.get('content-type') : '?'} `
    + `bytes=${html.length} title="${title.trim().replace(/\s+/g, ' ')}" markers=${markers.join('|') || 'none'} `
    + `hasResultList=${html.includes('resultList')} hasModuleOptions=${html.includes('data-module-options')}`;
}

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Extracts the JSON array that follows `"resultList":{"list":` — string-aware
// bracket matching so brackets inside bank promo texts can't break it.
function extractBankList(html) {
  const text = unescapeHtml(html);
  const marker = '"resultList":{"list":';
  const at = text.indexOf(marker);
  if (at < 0) throw new FxProviderError('banki', 'layout_changed', 'resultList marker missing');

  const start = text.indexOf('[', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); }
      catch (e) { throw new FxProviderError('banki', 'layout_changed', 'list JSON unparsable'); }
    }
  }
  throw new FxProviderError('banki', 'layout_changed', 'list not terminated');
}

// Pure: html → quotes for one side. Exported for fixture-based tests.
function parseQuotes(html, side, now = Date.now()) {
  const list = extractBankList(html);
  if (!Array.isArray(list)) throw new FxProviderError('banki', 'layout_changed', 'list is not an array');

  const quotes = [];
  let refreshedAt = null;
  for (const bank of list) {
    const ex = bank && bank.exchange;
    if (!ex || !Number.isFinite(ex.buy) || !Number.isFinite(ex.sale)) continue;
    if (!(ex.buy > 0 && ex.sale > 0) || ex.buy > ex.sale) continue; // inverted / garbage row
    const ts = Date.parse(ex.refreshDate);
    if (Number.isFinite(ts)) {
      if (Math.abs(now - ts) > MAX_AGE_MS) continue;                // stale row
      if (!refreshedAt || ts > refreshedAt) refreshedAt = ts;
    }
    quotes.push(side === 'bank_sells' ? ex.sale : ex.buy);
  }
  if (!quotes.length) throw new FxProviderError('banki', 'schema_mismatch', 'no usable rows');
  return { quotes, refreshedAt: refreshedAt ? new Date(refreshedAt).toISOString() : null };
}

async function fetchQuotes({ currency, side, fetchImpl = fetch, now = Date.now() }) {
  if (!SUPPORTED.has(currency)) throw new FxProviderError('banki', 'unsupported_currency', currency);

  const pageUrl = `https://www.banki.ru/products/currency/cash/${currency.toLowerCase()}/${REGION}/`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let html;
  let lastResp;
  try {
    const resp = await fetchImpl(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: ctl.signal });
    lastResp = resp;
    if (!resp.ok) throw new FxProviderError('banki', 'http_error', String(resp.status));
    html = await resp.text();
  } catch (err) {
    if (err instanceof FxProviderError) throw err;
    throw new FxProviderError('banki', 'network_error', err.name === 'AbortError' ? 'timeout' : err.message);
  } finally {
    clearTimeout(timer);
  }

  let parsed;
  try {
    parsed = parseQuotes(html, side, now);
  } catch (err) {
    if (err instanceof FxProviderError && err.reason === 'layout_changed') {
      throw new FxProviderError('banki', 'layout_changed', describeResponse(lastResp, html));
    }
    throw err;
  }
  return { quotes: parsed.quotes, provider: 'banki', refreshedAt: parsed.refreshedAt, pageUrl };
}

module.exports = { fetchQuotes, parseQuotes, extractBankList, FxProviderError };
