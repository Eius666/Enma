'use strict';

// ── Insight store — all Firestore operations for the insights subsystem ────────
//
// Storage path: users/{uid}/insights/{fingerprint}
// fingerprint IS the document ID — deterministic per event type + scope.
// This guarantees at-most-one active doc per event, preventing duplicates.

const { db, admin }                   = require('../firebaseAdmin');
const { INSIGHTS_CONFIG, computeInsightScore } = require('./config');
const { convertCurrency }             = require('../convertCurrency');

const TS = () => admin.firestore.FieldValue.serverTimestamp();

function insightsRef(uid) {
  return db.collection('users').doc(uid).collection('insights');
}

// ── upsertEvent — atomic create-or-update ─────────────────────────────────────
//
// Uses Firestore runTransaction for CAS-safe creation:
// - absent            → create with status='active'
// - active/shown      → update facts/severity/title; optionally clear notifiedAt
// - dismissed (cool)  → skip (within cooldown)
// - dismissed (stale) → re-activate
// - resolved          → re-activate if event recurs

async function upsertEvent(uid, eventData, opts = {}) {
  const { currency = 'RUB', rates = null } = opts;
  const ref = insightsRef(uid).doc(eventData.fingerprint);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (snap.exists) {
      const existing = snap.data();

      // Dismissed within cooldown → skip entirely
      if (existing.status === 'dismissed') {
        const cfg        = INSIGHTS_CONFIG[existing.type] || {};
        const cooldownMs = cfg.cooldownMs || 24 * 3600 * 1000;
        const updatedMs  = existing.updatedAt?.toMillis?.() || 0;
        if (Date.now() - updatedMs < cooldownMs) {
          return { result: 'skipped', reason: 'dismissed_cooldown' };
        }
      }

      // Event detection/update itself never depends on this — only whether a
      // FRESH Telegram re-notification is warranted. If the threshold can't
      // be safely converted, we simply don't re-notify; the event patch
      // below still applies (facts/severity stay current either way).
      const needsRenotify = checkSubstantialChange(existing, eventData, currency, rates);

      const patch = {
        severity:        eventData.severity,
        title:           eventData.title,
        bodyText:        eventData.bodyText,
        facts:           eventData.facts,
        detectorVersion: eventData.detectorVersion,
        // Re-activate if the event was resolved/dismissed and is now occurring again
        status: (existing.status === 'resolved' || existing.status === 'dismissed')
          ? 'active'
          : existing.status,
        updatedAt: TS(),
      };

      if (eventData.expiresAt) {
        patch.expiresAt = admin.firestore.Timestamp.fromMillis(eventData.expiresAt);
      }
      if (needsRenotify) {
        patch.notifiedAt = null; // allow Telegram re-notification
      }

      tx.update(ref, patch);
      return { result: needsRenotify ? 'updated_substantial' : 'updated' };
    }

    // ── Create new event ──────────────────────────────────────────────────────
    const doc = {
      uid,
      fingerprint:     eventData.fingerprint,
      type:            eventData.eventType,
      domain:          eventData.domain,
      severity:        eventData.severity,
      title:           eventData.title,
      bodyText:        eventData.bodyText,
      facts:           eventData.facts,
      action:          eventData.action || null,
      sourceEntityIds: eventData.sourceEntityIds || [],
      status:          'active',
      detectorVersion: eventData.detectorVersion,
      detectedAt:      TS(),
      updatedAt:       TS(),
      notifiedAt:      null,
    };
    if (eventData.expiresAt) {
      doc.expiresAt = admin.firestore.Timestamp.fromMillis(eventData.expiresAt);
    }
    tx.set(ref, doc);
    return { result: 'created' };
  });
}

// ── resolveEvent ──────────────────────────────────────────────────────────────

async function resolveEvent(uid, fingerprint) {
  const ref  = insightsRef(uid).doc(fingerprint);
  const snap = await ref.get();
  if (!snap.exists) return { result: 'not_found' };
  if (snap.data().status === 'resolved') return { result: 'already_resolved' };

  await ref.update({
    status:     'resolved',
    resolvedAt: TS(),
    updatedAt:  TS(),
  });
  return { result: 'resolved' };
}

// ── dismissEvent — user-initiated ────────────────────────────────────────────

async function dismissEvent(uid, fingerprint) {
  const ref  = insightsRef(uid).doc(fingerprint);
  const snap = await ref.get();
  if (!snap.exists)             return { result: 'not_found' };
  if (snap.data().uid !== uid)  return { result: 'forbidden' };
  if (snap.data().status === 'dismissed') return { result: 'already_dismissed' };

  await ref.update({ status: 'dismissed', updatedAt: TS() });
  return { result: 'dismissed' };
}

// ── loadActiveInsights ────────────────────────────────────────────────────────

async function loadActiveInsights(uid, limitN = 20) {
  const snap = await insightsRef(uid)
    .where('status', 'in', ['active', 'shown'])
    .orderBy('detectedAt', 'desc')
    .limit(limitN)
    .get();

  const now = Date.now();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(i => {
      if (!i.expiresAt) return true;
      const exMs = i.expiresAt?.toMillis?.() || 0;
      return exMs > now;
    });
}

// ── rankInsights ──────────────────────────────────────────────────────────────

function rankInsights(insights) {
  return insights
    .map(i => ({ ...i, score: computeInsightScore(i) }))
    .sort((a, b) => b.score - a.score);
}

// ── checkSubstantialChange — determines if re-notification is warranted ───────

function checkSubstantialChange(existing, updated, currency = 'RUB', rates = null) {
  if (existing.type !== updated.eventType) return false;
  if (existing.type === 'finance.cash_gap') {
    const cfg = INSIGHTS_CONFIG['finance.cash_gap'];
    const rawThreshold     = cfg.substantialChangeAmount   || 5000;
    const thresholdCurrency = cfg.substantialChangeCurrency || 'RUB';

    let threshold;
    if (thresholdCurrency === currency) {
      threshold = rawThreshold;
    } else if (rates) {
      threshold = convertCurrency(rawThreshold, thresholdCurrency, currency, rates);
    } else {
      // Can't safely convert the RUB-denominated threshold into `currency`
      // — never guess "no conversion needed." Skip re-notification only;
      // the event itself (facts/severity) is still updated by the caller.
      return false;
    }

    const oldGap = existing.facts?.gapAmount || 0;
    const newGap = updated.facts?.gapAmount  || 0;
    return Math.abs(newGap - oldGap) >= threshold;
  }
  return false;
}

module.exports = {
  upsertEvent,
  resolveEvent,
  dismissEvent,
  loadActiveInsights,
  rankInsights,
  checkSubstantialChange,
};
