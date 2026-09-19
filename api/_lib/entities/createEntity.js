'use strict';

// Shared "create an entity with the Free/Pro limit applied" helper. Used by the
// API's entityCreate action for transactions (server-authoritative money
// fields) — moved out of the removed Web-AI tool layer.

const { db, admin } = require('../firebaseAdmin');

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate  = () => new Date().toISOString().slice(0, 10);

const ENTITY_COLLECTION_MAP = {
  task:        'tasks',
  habit:       'habits',
  note:        'notes',
  transaction: 'transactions',
};

const FREE_ENTITY_CONFIG = {
  task:        { field: 'dailyTaskCount',   limit: 5,  windowField: 'date'  },
  habit:       { field: 'habitCount',       limit: 3                        },
  note:        { field: 'noteCount',        limit: 10                       },
  transaction: { field: 'transactionCount', limit: 30, windowField: 'month' },
};



async function getActivePlan(userId) {
  try {
    const snap = await db.collection('subscriptions').doc(userId).get();
    if (!snap.exists) return 'free';
    const sub = snap.data();
    if (sub.status !== 'active') return 'free';
    if (sub.plan === 'free' && sub.trialPlan && sub.trialEndDate) {
      if (new Date(sub.trialEndDate) > new Date()) return sub.trialPlan;
    }
    const endMs = sub.endDateMs ?? sub.expiresAt?.toMillis?.() ?? 0;
    if (endMs && endMs < Date.now()) return 'free';
    return sub.plan ?? 'free';
  } catch { return 'free'; }
}

// ── createEntityInFirestore — reuses Free/Pro limit logic ─────────────────────
// Returns { ok: true, id } or { ok: false, code, limit, current }

async function createEntityInFirestore(userId, entityType, data, docId) {
  const collectionName = ENTITY_COLLECTION_MAP[entityType];
  if (!collectionName) throw new Error(`Unknown entity type: ${entityType}`);

  const cfg       = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collectionName).doc(String(docId))
    : db.collection(collectionName).doc();
  const now     = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = { ...data, userId, createdAt: now, updatedAt: now };
  const plan    = await getActivePlan(userId);

  if (plan === 'free' && cfg) {
    const counterRef = db.collection('users').doc(userId).collection('freeUsage').doc('counters');
    const win = cfg.windowField === 'month' ? currentMonth()
              : cfg.windowField === 'date'  ? currentDate()
              : null;
    let limitExceeded = false;
    let currentCount  = 0;

    await db.runTransaction(async tx => {
      const counterSnap = await tx.get(counterRef);
      const counterData = counterSnap.exists ? counterSnap.data() : {};
      const storedWin   = win !== null ? String(counterData[cfg.windowField] ?? '') : null;
      const used        = (storedWin !== null && storedWin !== win) ? 0 : Number(counterData[cfg.field] ?? 0);

      currentCount = used;
      if (used >= cfg.limit) { limitExceeded = true; return; }

      tx.set(entityRef, baseDoc);
      const counterPatch = { userId, [cfg.field]: used + 1, updatedAt: now };
      if (win !== null) counterPatch[cfg.windowField] = win;
      tx.set(counterRef, counterPatch, { merge: true });
    });

    if (limitExceeded) {
      return { ok: false, code: 'LIMIT_REACHED', limit: cfg.limit, current: currentCount };
    }
  } else {
    await entityRef.set(baseDoc);
  }

  return { ok: true, id: entityRef.id };
}

module.exports = { createEntityInFirestore, getActivePlan };
