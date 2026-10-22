'use strict';

// Admin billing views and edits — POST /api/ai/adminSubscriptions,
// adminPayments and adminPromoCodes. Built by the api/ai router (see
// api/ai/[action].js).

function createBillingHandlers(ctx) {
  const { db, admin, requireAdmin } = ctx;

  async function updateSubscription(res, body) {
    const { userId, plan, periodMonths, status } = body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const update = { updatedAt: now };
    if (plan)   update.plan   = plan;
    if (status) update.status = status;
    if (periodMonths) {
      let expiresAt = new Date();
      const subSnap = await db.collection('subscriptions').doc(userId).get();
      if (subSnap.exists) {
        const ex = subSnap.data().expiresAt?.toDate?.();
        if (ex && ex > expiresAt) expiresAt = ex;
      }
      expiresAt.setMonth(expiresAt.getMonth() + Number(periodMonths));
      update.expiresAt = admin.firestore.Timestamp.fromDate(expiresAt);
      update.endDateMs = expiresAt.getTime();
    }
    await db.collection('subscriptions').doc(userId).set(update, { merge: true });
    if (status === 'cancelled') {
      await db.collection('users').doc(userId).set({ isPro: false, updatedAt: now }, { merge: true });
    }
    return res.status(200).json({ ok: true });
  }

  async function handleAdminSubscriptions(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};

    if (body.action === 'update') return updateSubscription(res, body);

    const { limit: lim = 100 } = body;
    const limit = Math.min(Number(lim) || 100, 200);
    const snap  = await db.collection('subscriptions').orderBy('updatedAt', 'desc').limit(limit).get();

    const subs = snap.docs.map(d => {
      const data = d.data();
      return {
        userId:        d.id,
        plan:          data.plan,
        period:        data.period,
        status:        data.status,
        endDate:       data.endDate || data.expiresAt?.toDate?.()?.toISOString?.() || '',
        endDateMs:     data.endDateMs,
        paymentMethod: data.paymentMethod || data.lastPaymentMethod,
        promoCode:     data.promoCode || '',
        referralCode:  data.referralCode || '',
        grantedByAdmin:data.grantedByAdmin || false,
        updatedAt:     data.updatedAt?.toDate?.()?.toISOString?.() || '',
      };
    });

    return res.status(200).json({ ok: true, subscriptions: subs });
  }

  async function handleAdminPayments(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};
    const { limit: lim = 100, statusFilter, methodFilter } = body;
    const limit = Math.min(Number(lim) || 100, 200);

    const snap = await db.collection('payments').orderBy('createdAt', 'desc').limit(limit).get();

    let payments = snap.docs.map(d => {
      const data   = d.data();
      const method = data.method
        || (data.transactionId ? 'sbp' : data.txHash ? 'ton' : data.network ? data.network : 'unknown');
      return {
        id:          d.id,
        userId:      data.userId,
        amount:      data.amount || data.finalAmount || 0,
        method,
        status:      data.status,
        createdAt:   data.createdAt?.toDate?.()?.toISOString?.() || '',
        promoCode:   data.promoCode || '',
        referralCode:data.referralCode || '',
        plan:        data.plan || '',
        period:      data.period || '',
        transactionId: data.transactionId || '',
      };
    });

    if (statusFilter) payments = payments.filter(p => p.status === statusFilter);
    if (methodFilter) payments = payments.filter(p => p.method === methodFilter);

    const totalRevenue = payments
      .filter(p => ['CONFIRMED', 'confirmed'].includes(p.status))
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    return res.status(200).json({ ok: true, payments, totalRevenue });
  }

  async function handleAdminPromoCodes(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};

    if (body.action === 'create') {
      const { code, discountPercent, maxUses } = body;
      if (!code || discountPercent === undefined || !maxUses) {
        return res.status(400).json({ error: 'code, discountPercent, maxUses required' });
      }
      const codeUpper = code.toUpperCase().trim();
      await db.collection('promoCodes').doc(codeUpper).set({
        code: codeUpper,
        discountPercent: Number(discountPercent),
        maxUses:         Number(maxUses),
        usedCount:       0,
        active:          true,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, code: codeUpper });
    }

    if (body.action === 'toggle') {
      const { code, active } = body;
      if (!code) return res.status(400).json({ error: 'code required' });
      await db.collection('promoCodes').doc(code.toUpperCase()).update({ active: Boolean(active) });
      return res.status(200).json({ ok: true });
    }

    // Seed all known codes to Firestore before listing (idempotent)
    const { seedAllPromoCodes } = require('../promoCodes');
    await seedAllPromoCodes();

    const snap  = await db.collection('promoCodes').get();
    const codes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ ok: true, codes });
  }

  return { handleAdminSubscriptions, handleAdminPayments, handleAdminPromoCodes };
}

module.exports = { createBillingHandlers };
