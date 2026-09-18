'use strict';

// Robust aggregation of bank quotes into one rate.
//
// Never a blind mean: bank quotes contain outliers (stale rows, inverted
// columns, promo rates). We take the median after dropping values that sit
// too far from it in MAD terms, and refuse to answer at all when fewer than
// MIN_BANK_SAMPLE quotes survive — one random bank is not "the bank rate".

const MIN_BANK_SAMPLE = 5;
const MAD_K           = 3.5;   // conventional modified-z-score cutoff
const MIN_TOLERANCE   = 0.01;  // never trim tighter than ±1% of the median

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function aggregateQuotes(rawValues, { minSample = MIN_BANK_SAMPLE } = {}) {
  const values = (rawValues || []).filter(v => Number.isFinite(v) && v > 0);
  if (values.length < minSample) {
    return { ok: false, reason: 'insufficient_sample', sampleSize: values.length };
  }

  const m   = median(values);
  const mad = median(values.map(v => Math.abs(v - m)));
  const tol = Math.max(MAD_K * 1.4826 * mad, MIN_TOLERANCE * m);
  const kept = values.filter(v => Math.abs(v - m) <= tol);

  if (kept.length < minSample) {
    return { ok: false, reason: 'insufficient_sample_after_filter', sampleSize: kept.length };
  }

  return {
    ok:         true,
    rate:       median(kept),
    sampleSize: kept.length,
    discarded:  values.length - kept.length,
    method:     'median_mad_filtered',
  };
}

module.exports = { aggregateQuotes, median, MIN_BANK_SAMPLE };
