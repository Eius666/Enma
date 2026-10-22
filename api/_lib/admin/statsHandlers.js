'use strict';

// Admin dashboard figures — POST /api/ai/adminStats and adminAiUsage.
// Read-only. Built by the api/ai router (see api/ai/[action].js).

const DAY_MS = 86400000;
const CONFIRMED = ['CONFIRMED', 'confirmed'];

// New registrations today / this week / this month and per day for 30 days.
function summarizeRegistrations(usersSnap, { todayStart, weekStart, monthStart, thirtyAgo }) {
  let newToday = 0, newWeek = 0, newMonth = 0;
  const regsByDay = {};
  usersSnap.docs.forEach(d => {
    const created = d.data().createdAt?.toDate?.();
    if (!created) return;
    if (created >= todayStart) newToday++;
    if (created >= weekStart)  newWeek++;
    if (created >= monthStart) newMonth++;
    if (created >= thirtyAgo) {
      const day = created.toISOString().slice(0, 10);
      regsByDay[day] = (regsByDay[day] || 0) + 1;
    }
  });
  return { newToday, newWeek, newMonth, regsByDay };
}

// Users per plan, counting only active, unexpired subscriptions.
function summarizePlans(totalUsers, subsSnap) {
  const planDist   = { free: totalUsers, pro: 0, premium: 0 };
  let payingUsers  = 0;
  subsSnap.docs.forEach(d => {
    const sub  = d.data();
    if (sub.status !== 'active') return;
    const endMs = sub.endDateMs ?? sub.expiresAt?.toMillis?.() ?? 0;
    if (endMs && endMs < Date.now()) return;
    const plan = sub.plan || 'free';
    if (plan === 'pro')     { planDist.pro++;     planDist.free--; payingUsers++; }
    if (plan === 'premium') { planDist.premium++; planDist.free--; payingUsers++; }
  });
  if (planDist.free < 0) planDist.free = 0;
  return { planDist, payingUsers };
}

function summarizeRevenue(paymentsSnap, { monthStart, thirtyAgo }) {
  let revenueMonth = 0;
  const revByDay   = {};
  paymentsSnap.docs.forEach(d => {
    const data    = d.data();
    const created = data.createdAt?.toDate?.();
    const day     = created?.toISOString?.()?.slice(0, 10);
    const amount  = data.amount || data.finalAmount || 0;
    if (created >= monthStart) revenueMonth += amount;
    if (created >= thirtyAgo && day) revByDay[day] = (revByDay[day] || 0) + amount;
  });
  return { revenueMonth, revByDay };
}

function summarizeReferrers(referrersSnap) {
  let pendingPayouts = 0;
  const topReferrers = [];
  referrersSnap.docs.forEach(d => {
    const data = { id: d.id, ...d.data() };
    pendingPayouts += data.pendingPayout || 0;
    topReferrers.push(data);
  });
  topReferrers.sort((a, b) => (b.totalEarned || 0) - (a.totalEarned || 0));
  return { pendingPayouts, topReferrers };
}

function countAiRequests(aiSnap) {
  let aiRequestsMonth = 0;
  aiSnap.docs.forEach(d => {
    const data = d.data();
    aiRequestsMonth += (data.textRequests || 0) + (data.imageRequests || 0) + (data.pdfReports || 0);
  });
  return aiRequestsMonth;
}

function createStatsHandlers(ctx) {
  const { db, requireAdmin } = ctx;

  // Recent confirmed payments (last 10) — may need composite index; non-fatal
  async function loadRecentPayments() {
    let recentPayments = [];
    try {
      const recentPaymentsSnap = await db.collection('payments')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();
      recentPayments = recentPaymentsSnap.docs
        .filter(d => CONFIRMED.includes(d.data().status))
        .slice(0, 10)
        .map(d => ({
          id:       d.id,
          userId:   d.data().userId,
          amount:   d.data().amount || d.data().finalAmount || 0,
          plan:     d.data().plan || '',
          method:   d.data().method || (d.data().transactionId ? 'sbp' : d.data().txHash ? 'ton' : ''),
          promoCode:d.data().promoCode || '',
          createdAt:d.data().createdAt?.toDate?.()?.toISOString?.() || '',
        }));
    } catch (e) {
      console.warn('[adminStats] recentPayments query failed:', e.message);
    }
    return recentPayments;
  }

  // Recent registrations (last 10)
  async function loadRecentUsers() {
    const recentUsersSnap = await db.collection('users').orderBy('createdAt', 'desc').limit(10).get();
    return recentUsersSnap.docs.map(d => ({
      uid:         d.id,
      displayName: d.data().displayName || d.data().first_name || '',
      username:    d.data().username || '',
      createdAt:   d.data().createdAt?.toDate?.()?.toISOString?.() || '',
    }));
  }

  async function handleAdminStats(req, res) {
    if (!requireAdmin(req, res)) return;

    const now    = new Date();
    const bounds = {
      todayStart: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      weekStart:  new Date(now.getTime() - 7 * DAY_MS),
      monthStart: new Date(now.getFullYear(), now.getMonth(), 1),
      thirtyAgo:  new Date(now.getTime() - 30 * DAY_MS),
    };
    const monthKey = now.toISOString().slice(0, 7);

    const [usersSnap, subsSnap, paymentsSnap, referrersSnap, aiSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('subscriptions').get(),
      db.collection('payments').where('status', 'in', CONFIRMED).get(),
      db.collection('referrers').get(),
      db.collection('aiUsage').where('month', '==', monthKey).get(),
    ]);

    const { newToday, newWeek, newMonth, regsByDay } = summarizeRegistrations(usersSnap, bounds);
    const { planDist, payingUsers } = summarizePlans(usersSnap.size, subsSnap);
    const { revenueMonth, revByDay } = summarizeRevenue(paymentsSnap, bounds);
    const { pendingPayouts, topReferrers } = summarizeReferrers(referrersSnap);
    const aiRequestsMonth = countAiRequests(aiSnap);
    const recentPayments = await loadRecentPayments();
    const recentUsers = await loadRecentUsers();

    return res.status(200).json({
      totalUsers: usersSnap.size, payingUsers,
      newToday, newWeek, newMonth,
      revenueMonth, pendingPayouts, aiRequestsMonth,
      topReferrers: topReferrers.slice(0, 5),
      regsByDay, revByDay, planDist,
      recentPayments, recentUsers,
    });
  }

  async function handleAdminAiUsage(req, res) {
    if (!requireAdmin(req, res)) return;

    const body     = req.body ?? {};
    const monthKey = body.month || new Date().toISOString().slice(0, 7);
    const limit    = Math.min(Number(body.limit) || 100, 200);

    const snap = await db.collection('aiUsage').where('month', '==', monthKey).limit(limit).get();

    let totalText = 0, totalImage = 0, totalPdf = 0;
    const usage = snap.docs.map(d => {
      const data = d.data();
      totalText  += data.textRequests  || 0;
      totalImage += data.imageRequests || 0;
      totalPdf   += data.pdfReports    || 0;
      return {
        userId:       d.id,
        textRequests: data.textRequests  || 0,
        imageRequests:data.imageRequests || 0,
        pdfReports:   data.pdfReports    || 0,
        updatedAt:    data.updatedAt?.toDate?.()?.toISOString?.() || '',
      };
    });

    return res.status(200).json({
      ok: true, month: monthKey, usage,
      totals: { textRequests: totalText, imageRequests: totalImage, pdfReports: totalPdf },
    });
  }

  return { handleAdminStats, handleAdminAiUsage };
}

module.exports = { createStatsHandlers };
