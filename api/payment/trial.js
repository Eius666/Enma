'use strict';

const { admin, db } = require('../_lib/firebaseAdmin');

const TRIAL_DAYS = 7;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    const userRef  = db.collection('users').doc(userId);
    const userSnap = await userRef.get();

    if (userSnap.exists && userSnap.data()?.trialUsed === true) {
      return res.status(409).json({ error: 'Trial already used', code: 'TRIAL_USED' });
    }

    const now         = new Date();
    const trialEnd    = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
    trialEnd.setHours(23, 59, 59, 999);

    const subId  = `trial_${userId}`;
    const subRef = db.collection('subscriptions').doc(userId);

    await db.runTransaction(async tx => {
      tx.set(subRef, {
        id:             subId,
        userId,
        plan:           'free',
        trialPlan:      'premium',
        period:         'month',
        status:         'active',
        startDate:      now.toISOString(),
        endDate:        trialEnd.toISOString(),
        endDateMs:      trialEnd.getTime(),
        trialEndDate:   trialEnd.toISOString(),
        trialEndDateMs: trialEnd.getTime(),
        paymentMethod:  'trial',
        createdAt:      now.toISOString(),
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(userRef, { trialUsed: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });

    return res.status(200).json({ ok: true, trialEndDate: trialEnd.toISOString() });
  } catch (err) {
    console.error('[payment/trial] error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
