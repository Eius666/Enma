'use strict';

const { convertCurrency } = require('../convertCurrency');
const { resolveTransactionCurrency } = require('./resolveLegacyCurrency');
const { hasLockedRub } = require('./lockedAmount');
const { HOME_BUDGET_CURRENCY } = require('../config');

// True when at least one transaction is denominated in something other than
// targetCurrency (or its currency cannot be resolved at all) — i.e. FX rates
// will actually be needed, or the batch cannot be safely computed regardless
// of FX. A RUB-only or USD-only dataset with resolvable currencies never
// needs rates, so callers must not fetch FX unless this returns true.
function needsFx(transactions, targetCurrency) {
  return transactions.some(tx => {
    if (hasLockedRub(tx) && targetCurrency === HOME_BUDGET_CURRENCY) return false; // locked ₽ value — never needs FX
    const resolved = resolveTransactionCurrency(tx);
    return resolved.currency !== targetCurrency; // null !== targetCurrency is also true — forces the ok:false path below
  });
}

// Converts every transaction's amount into targetCurrency ONCE, before any
// financial math runs — calculators and detectors then just sum `amount`
// without needing to know about currency at all.
//
// Currency is resolved via resolveTransactionCurrency — NEVER a blanket
// "missing currency = RUB" guess. A transaction whose real historical
// currency cannot be proven (confidence: 'unknown') makes the whole batch
// unsafe to compute exactly, exactly like an unavailable FX rate: both mean
// "we cannot state a real number here."
//
// Read-time only: never mutates the input array/objects, never writes back
// to Firestore. originalAmount/originalCurrency are preserved on every
// returned copy (even identity conversions) for debugging/output.
//
// Returns { transactions, ok }:
//   ok === false → at least one transaction either has unknown currency, or
//   needed FX conversion that was unavailable. Callers MUST NOT fall back to
//   raw amounts or treat differing/unknown currencies as equal — that
//   produces false numbers. The correct response is a safe degradation
//   (e.g. insufficient_currency_data), never a partial or silently-wrong total.
function normalizeTransactionsCurrency(transactions, targetCurrency, rates) {
  const normalized = [];
  for (const tx of transactions) {
    // schemaVersion 2: the ruble value was locked at creation. Budget is RUB,
    // so it is used as-is — history is never re-priced with today's FX.
    if (hasLockedRub(tx) && targetCurrency === HOME_BUDGET_CURRENCY) {
      normalized.push({
        ...tx,
        amount:           tx.rubAmount,
        currency:         targetCurrency,
        originalAmount:   tx.amount,
        originalCurrency: tx.currency,
        currencyConfidence: 'locked',
      });
      continue;
    }

    const resolved = resolveTransactionCurrency(tx);

    if (resolved.currency === null) {
      return { transactions: null, ok: false };
    }

    const originalCurrency = resolved.currency;

    if (originalCurrency === targetCurrency) {
      // Identity conversion — no FX involved, works even if FX is offline.
      normalized.push({
        ...tx,
        amount:           tx.amount,
        currency:         targetCurrency,
        originalAmount:   tx.amount,
        originalCurrency,
        currencyConfidence: resolved.confidence,
      });
      continue;
    }

    if (!rates) {
      return { transactions: null, ok: false };
    }

    normalized.push({
      ...tx,
      amount:           convertCurrency(tx.amount, originalCurrency, targetCurrency, rates),
      currency:         targetCurrency,
      originalAmount:   tx.amount,
      originalCurrency,
      currencyConfidence: resolved.confidence,
    });
  }
  return { transactions: normalized, ok: true };
}

// Same read-time-only, never-mutate, never-guess principle for goals.
// Unlike transactions, every goal ever created in ENMA (Telegram's
// createGoal, the only write path — there is no Web UI for goals and no
// AI-chat goal tool) has stamped a `currency` field since the feature's
// first commit, so 'RUB' here is a genuine "field truly absent" fallback,
// not a legacy-guess for a known-corrupted population.
function normalizeGoalsCurrency(goals, targetCurrency, rates) {
  const normalized = [];
  for (const g of goals) {
    const originalCurrency = g.currency || 'RUB';

    if (originalCurrency === targetCurrency) {
      normalized.push({
        ...g,
        targetAmount:          g.targetAmount,
        currentAmount:         g.currentAmount,
        currency:              targetCurrency,
        originalTargetAmount:  g.targetAmount,
        originalCurrentAmount: g.currentAmount,
        originalCurrency,
      });
      continue;
    }

    if (!rates) {
      return { goals: null, ok: false };
    }

    normalized.push({
      ...g,
      targetAmount:          convertCurrency(g.targetAmount,  originalCurrency, targetCurrency, rates),
      currentAmount:         convertCurrency(g.currentAmount, originalCurrency, targetCurrency, rates),
      currency:              targetCurrency,
      originalTargetAmount:  g.targetAmount,
      originalCurrentAmount: g.currentAmount,
      originalCurrency,
    });
  }
  return { goals: normalized, ok: true };
}

function goalsNeedFx(goals, targetCurrency) {
  return goals.some(g => (g.currency || 'RUB') !== targetCurrency);
}

module.exports = {
  normalizeTransactionsCurrency,
  needsFx,
  normalizeGoalsCurrency,
  goalsNeedFx,
};
