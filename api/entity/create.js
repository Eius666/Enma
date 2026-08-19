'use strict';

const { db, admin } = require('../_lib/firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Config — mirrors src/subscription.ts FREE_LIMITS + src/lib/usageCounters.ts
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTION_MAP = {
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

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate  = () => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Plan resolution — mirrors getActivePlan in api/ai/[action].js
// ─────────────────────────────────────────────────────────────────────────────

async function getActivePlan(userId) {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, entityType, data, docId } = req.body ?? {};

  if (!userId || !entityType || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing userId, entityType, or data' });
  }

  const collection = COLLECTION_MAP[entityType];
  if (!collection) {
    return res.status(400).json({ error: `Unknown entityType: ${entityType}` });
  }

  const cfg = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collection).doc(String(docId))
    : db.collection(collection).doc();

  const now = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = {
    ...data,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const plan  = await getActivePlan(userId);
    const isFree = plan === 'free';

    if (isFree && cfg) {
      const counterRef = db
        .collection('users').doc(userId)
        .collection('freeUsage').doc('counters');

      const win = cfg.windowField === 'month' ? currentMonth()
                : cfg.windowField === 'date'  ? currentDate()
                : null;

      let limitExceeded = false;
      let currentCount  = 0;

      await db.runTransaction(async tx => {
        const counterSnap = await tx.get(counterRef);
        const counterData = counterSnap.exists ? counterSnap.data() : {};

        const storedWin = win !== null ? String(counterData[cfg.windowField] ?? '') : null;
        const used = (storedWin !== null && storedWin !== win)
          ? 0
          : Number(counterData[cfg.field] ?? 0);

        currentCount = used;

        if (used >= cfg.limit) {
          limitExceeded = true;
          return;
        }

        // Create entity + increment counter in one atomic step
        tx.set(entityRef, baseDoc);

        const counterPatch = {
          userId,
          [cfg.field]: used + 1,
          updatedAt: now,
        };
        if (win !== null) counterPatch[cfg.windowField] = win;
        tx.set(counterRef, counterPatch, { merge: true });
      });

      if (limitExceeded) {
        return res.status(429).json({
          error: 'Limit exceeded',
          code:  'free_limit',
          limit: cfg.limit,
          current: currentCount,
        });
      }
    } else {
      // Paid plan or entity type without a free limit
      await entityRef.set(baseDoc);
    }

    return res.status(200).json({ ok: true, id: entityRef.id });

  } catch (err) {
    console.error('[entity/create] error:', err.message);
    return res.status(500).json({ error: 'Failed to create entity' });
  }
};
