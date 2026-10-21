'use strict';

// Shared "create an entity with the Free/Pro limit applied" helper. Used by the
// API's entityCreate action for transactions (server-authoritative money
// fields) — moved out of the removed Web-AI tool layer.
//
// deps.firebase ({ db, admin }) is optional and defaults to the real
// Firebase Admin module — every existing caller keeps working unchanged.
// It exists so integration tests can point this at the Firestore EMULATOR
// without needing FIREBASE_SERVICE_ACCOUNT (see
// api/_lib/entities/__tests__/createEntity.integration.test.js), the same
// pattern already used by api/_lib/finance/goalTransfer.js.

const { resolveActivePlan } = require('../subscription/plan');
const defaultFirebase = require('../firebaseAdmin');

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate  = () => new Date().toISOString().slice(0, 10);

const ENTITY_COLLECTION_MAP = {
  task:        'tasks',
  habit:       'habits',
  note:        'notes',
  transaction: 'transactions',
};

// `windowField` entities (task/transaction) reset their counter every
// day/month, so a delete mid-window just leaves a little slack until the
// window rolls over on its own — never permanently stuck.
//
// `liveCount` entities (habit/note) are "N total, ever" caps with NO
// window to reset them. ENMA notes-durability audit, incident: "лимит
// заметок достигнут, но все заметки исчезли из интерфейса" — root cause
// was exactly this: the OLD implementation incremented a stored counter
// on every create and NEVER decremented it on delete (no code anywhere in
// the repo writes to it except this function), so the counter is
// monotonically non-decreasing while the real document count can drop to
// zero (user deletes notes, or a draft never actually synced) — "limit
// reached" then persists forever, independent of how many documents
// actually still exist. Fixed by deriving `used` from a live count of the
// user's own documents, read inside the SAME transaction as the create
// (so it stays atomic — no two-tab race can slip past the check), instead
// of trusting a separately-tracked value that nothing keeps in sync.
const FREE_ENTITY_CONFIG = {
  task:        { field: 'dailyTaskCount',   limit: 5,  windowField: 'date'  },
  habit:       { field: 'habitCount',       limit: 3,  liveCount: true      },
  note:        { field: 'noteCount',        limit: 10, liveCount: true      },
  transaction: { field: 'transactionCount', limit: 30, windowField: 'month' },
};



async function getActivePlan(userId, deps = {}) {
  const { db } = deps.firebase || defaultFirebase;
  try {
    const snap = await db.collection('subscriptions').doc(userId).get();
    if (!snap.exists) return 'free';
    return resolveActivePlan(snap.data());
  } catch { return 'free'; }
}

// ── createEntityInFirestore — reuses Free/Pro limit logic ─────────────────────
// Returns { ok: true, id } or { ok: false, code, limit, current }

async function createEntityInFirestore(userId, entityType, data, docId, deps = {}) {
  const { db, admin } = deps.firebase || defaultFirebase;

  const collectionName = ENTITY_COLLECTION_MAP[entityType];
  if (!collectionName) throw new Error(`Unknown entity type: ${entityType}`);

  const cfg       = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collectionName).doc(String(docId))
    : db.collection(collectionName).doc();
  const now     = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = { ...data, userId, createdAt: now, updatedAt: now };
  const plan    = await getActivePlan(userId, deps);

  if (plan === 'free' && cfg) {
    const counterRef = db.collection('users').doc(userId).collection('freeUsage').doc('counters');
    const win = cfg.windowField === 'month' ? currentMonth()
              : cfg.windowField === 'date'  ? currentDate()
              : null;
    let limitExceeded = false;
    let currentCount  = 0;

    await db.runTransaction(async tx => {
      let used;

      if (cfg.liveCount) {
        // The caps here (habits: 3, notes: 10) are small enough that
        // reading the user's own matching documents directly inside the
        // transaction is cheap and, unlike a separately-tracked counter,
        // cannot drift from reality — it IS reality, read atomically
        // alongside the write below.
        const liveSnap = await tx.get(db.collection(collectionName).where('userId', '==', userId));
        used = liveSnap.size;
      } else {
        const counterSnap = await tx.get(counterRef);
        const counterData = counterSnap.exists ? counterSnap.data() : {};
        const storedWin   = win !== null ? String(counterData[cfg.windowField] ?? '') : null;
        used = (storedWin !== null && storedWin !== win) ? 0 : Number(counterData[cfg.field] ?? 0);
      }

      currentCount = used;
      if (used >= cfg.limit) { limitExceeded = true; return; }

      tx.set(entityRef, baseDoc);
      // Still written even for liveCount entities — not what the next
      // create's check relies on any more, but SettingsScreen's "X/Y used"
      // display reads this field directly, and writing the just-observed
      // true count here keeps it accurate instead of leaving it stale.
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

module.exports = { createEntityInFirestore, getActivePlan, ENTITY_COLLECTION_MAP };
