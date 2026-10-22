'use strict';

// Admin management of referrers (partners) and their payouts — POST
// /api/ai/adminReferrals and referralPayout. Built by the api/ai router (see
// api/ai/[action].js).
//
// The two payout paths are intentionally kept separate: referralPayout pays
// pending earnings oldest first and reports how many were paid; the
// adminReferrals payout does neither. Unifying them would change behaviour.

function createReferralAdminHandlers(ctx) {
  const { db, admin, requireAdmin } = ctx;

  async function createReferrer(res, body) {
    const { code, name, commissionPercent = 30, discountPercent = 10 } = body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const codeUpper = code.toUpperCase().trim();
    await db.collection('referrers').doc(codeUpper).set({
      code: codeUpper, name,
      commissionPercent: Number(commissionPercent),
      discountPercent:   Number(discountPercent),
      status: 'active', totalEarned: 0, pendingPayout: 0, paidOut: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, code: codeUpper });
  }

  async function updateReferrer(res, body) {
    const { referrerId, commissionPercent, discountPercent, status, paymentDetails } = body;
    if (!referrerId) return res.status(400).json({ error: 'referrerId required' });
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (commissionPercent !== undefined) update.commissionPercent = Number(commissionPercent);
    if (discountPercent   !== undefined) update.discountPercent   = Number(discountPercent);
    if (status)           update.status         = status;
    if (paymentDetails)   update.paymentDetails = paymentDetails;
    await db.collection('referrers').doc(String(referrerId).toUpperCase()).update(update);
    return res.status(200).json({ ok: true });
  }

  async function payoutFromAdminPanel(res, body) {
    const { referrerId, amount } = body;
    if (!referrerId || !amount) return res.status(400).json({ error: 'referrerId and amount required' });
    const referrerRef  = db.collection('referrers').doc(String(referrerId).toUpperCase());
    const referrerSnap = await referrerRef.get();
    if (!referrerSnap.exists) return res.status(404).json({ error: 'referrer_not_found' });
    const payAmount = Math.min(Number(amount), referrerSnap.data().pendingPayout || 0);
    if (payAmount <= 0) return res.status(400).json({ error: 'nothing_to_pay' });

    const earningsSnap = await db.collection('referralEarnings')
      .where('referrerId', '==', String(referrerId).toUpperCase())
      .where('status', '==', 'pending')
      .get();

    let remaining = payAmount;
    const now     = admin.firestore.FieldValue.serverTimestamp();
    const batch   = db.batch();
    for (const earnDoc of earningsSnap.docs) {
      if (remaining <= 0) break;
      const { commission } = earnDoc.data();
      if (commission <= remaining + 0.001) {
        batch.update(earnDoc.ref, { status: 'paid', paidAt: now });
        remaining -= commission;
      }
    }
    batch.update(referrerRef, {
      pendingPayout: admin.firestore.FieldValue.increment(-payAmount),
      paidOut:       admin.firestore.FieldValue.increment(payAmount),
    });
    await batch.commit();
    return res.status(200).json({ ok: true, paidAmount: payAmount });
  }

  async function listReferrers(res) {
    const [referrersSnap, earningsSnap] = await Promise.all([
      db.collection('referrers').get(),
      db.collection('referralEarnings').orderBy('createdAt', 'desc').limit(200).get(),
    ]);

    const referrers = referrersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const earnings  = earningsSnap.docs.map(d => ({
      id: d.id, ...d.data(),
      createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() || '',
    }));

    return res.status(200).json({ ok: true, referrers, earnings });
  }

  async function handleAdminReferrals(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};

    if (body.action === 'create') return createReferrer(res, body);
    if (body.action === 'update') return updateReferrer(res, body);
    if (body.action === 'payout') return payoutFromAdminPanel(res, body);
    return listReferrers(res);
  }

  // POST { listOnly: true, minAmount? }        → list pending referrers
  // POST { referrerId, amount }                → mark earnings paid
  async function handleReferralPayout(req, res) {
    const adminKey = process.env.ADMIN_API_KEY;
    if (adminKey && req.headers['x-admin-key'] !== adminKey) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = req.body ?? {};

    if (body.listOnly) {
      const minAmount = Number(body.minAmount) || 0;
      const snap = await db.collection('referrers')
        .where('pendingPayout', '>=', minAmount)
        .get();
      const referrers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.status(200).json({ ok: true, referrers });
    }

    const { referrerId, amount } = body;
    if (!referrerId || !amount) {
      return res.status(400).json({ error: 'referrerId and amount are required' });
    }

    const referrerRef  = db.collection('referrers').doc(String(referrerId).toUpperCase());
    const referrerSnap = await referrerRef.get();
    if (!referrerSnap.exists) return res.status(404).json({ error: 'referrer_not_found' });

    const payAmount = Math.min(Number(amount), referrerSnap.data().pendingPayout || 0);
    if (payAmount <= 0) return res.status(400).json({ error: 'nothing_to_pay' });

    const earningsSnap = await db.collection('referralEarnings')
      .where('referrerId', '==', String(referrerId).toUpperCase())
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .get();

    let remaining   = payAmount;
    let paidCount   = 0;
    const now       = admin.firestore.FieldValue.serverTimestamp();
    const batch     = db.batch();

    for (const earnDoc of earningsSnap.docs) {
      if (remaining <= 0) break;
      const { commission } = earnDoc.data();
      if (commission <= remaining + 0.001) {
        batch.update(earnDoc.ref, { status: 'paid', paidAt: now });
        remaining -= commission;
        paidCount++;
      }
    }

    batch.update(referrerRef, {
      pendingPayout: admin.firestore.FieldValue.increment(-payAmount),
      paidOut:       admin.firestore.FieldValue.increment(payAmount),
    });

    await batch.commit();

    return res.status(200).json({ ok: true, paidAmount: payAmount, paidEarningsCount: paidCount });
  }

  return { handleAdminReferrals, handleReferralPayout };
}

module.exports = { createReferralAdminHandlers };
