'use strict';

// Server-side AI usage accounting. api/ is plain CommonJS JS, so a
// browser-bundled .ts file under src/ can't be required from here; this
// module holds the pure merge logic (and the exact same
// Firestore document shape: aiUsage/{userId} — userId, month, textRequests,
// imageRequests, pdfReports) so SettingsScreen.tsx's existing usage display
// stays correct without any change on that side.

const { db } = require('./firebaseAdmin');
const { AI_LIMITS } = require('./subscription/plan'); // single definition, parity-tested against src/subscription.ts

const currentMonth = () => new Date().toISOString().slice(0, 7);

function buildIncrement(currentData, type, month) {
  const sameMonth = currentData?.month === month;
  return {
    userId:        currentData?.userId ?? '',
    month,
    textRequests:  (sameMonth ? (currentData?.textRequests  ?? 0) : 0) + (type === 'text'  ? 1 : 0),
    imageRequests: (sameMonth ? (currentData?.imageRequests ?? 0) : 0) + (type === 'image' ? 1 : 0),
    pdfReports:    (sameMonth ? (currentData?.pdfReports    ?? 0) : 0) + (type === 'pdf'   ? 1 : 0),
  };
}

/**
 * Atomically checks the given plan's limit for `type` against this
 * month's usage and, if allowed, increments it in the same transaction —
 * two concurrent requests can never both slip under a limit of 1.
 * Returns { allowed, used, limit } — `used`/`limit` are the values AFTER
 * a successful increment, or the current (unchanged) values when denied.
 */
async function checkAndIncrementAiUsage(userId, limits, type) {
  const limit = type === 'text' ? limits.textRequests
              : type === 'image' ? limits.imageRequests
              : limits.pdfReports;

  if (limit === 0) return { allowed: false, used: 0, limit: 0 };

  const month = currentMonth();
  const ref = db.collection('aiUsage').doc(userId);

  let allowed = false;
  let used = 0;

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? { userId, ...snap.data() } : undefined;
    const sameMonth = current?.month === month;
    const before = type === 'text' ? (sameMonth ? current?.textRequests ?? 0 : 0)
                 : type === 'image' ? (sameMonth ? current?.imageRequests ?? 0 : 0)
                 : (sameMonth ? current?.pdfReports ?? 0 : 0);

    if (before >= limit) {
      allowed = false;
      used = before;
      return;
    }

    const next = buildIncrement(current, type, month);
    tx.set(ref, next, { merge: false }); // full replace, matching buildAiUsageIncrement's own contract (resets other-month counters to 0)
    allowed = true;
    used = type === 'text' ? next.textRequests : type === 'image' ? next.imageRequests : next.pdfReports;
  });

  return { allowed, used, limit };
}

module.exports = { checkAndIncrementAiUsage, buildIncrement, currentMonth, AI_LIMITS };
