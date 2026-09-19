'use strict';

const { db, admin } = require('../_lib/firebaseAdmin');
const { HOME_BUDGET_CURRENCY } = require('../_lib/config');
const { createEntityInFirestore, getActivePlan } = require('../_lib/entities/createEntity');
const { createFinancialTransaction, buildTransactionUpdate, TransactionValidationError } = require('../_lib/transactions/financialTransaction');
const { FxUnavailableError } = require('../_lib/fx');
const crypto        = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) — no external dependencies, uses Node.js built-in crypto
// ─────────────────────────────────────────────────────────────────────────────

function _totpBase32Decode(base32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = base32.replace(/\s/g, '').toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0;
  const bytes = [];
  for (const c of s) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function _hotpCode(keyBuf, T) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(T / 0x100000000), 0);
  buf.writeUInt32BE(T >>> 0, 4);
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const o = h[19] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o+1] & 0xff) << 16) | ((h[o+2] & 0xff) << 8) | (h[o+3] & 0xff);
  return (n % 1_000_000).toString().padStart(6, '0');
}

// Accepts ±1 time-step window to handle clock skew
function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  const key = _totpBase32Decode(secret);
  const T   = Math.floor(Date.now() / 30_000);
  const t   = String(token).replace(/\s/g, '');
  return [-1, 0, 1].some(d => _hotpCode(key, T + d) === t);
}

// Generates a cryptographically random base32 secret (160 bits)
function generateTotpSecret() {
  const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(20);
  let r = '', bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { r += C[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) r += C[(val << (5 - bits)) & 31];
  return r;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

async function requireAuth(req, res) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('[AI_AUTH] Missing authorization token');
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (err) {
    console.warn('[AI_AUTH] Invalid Firebase token:', err.code || err.message);
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

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

const currentDate = () => new Date().toISOString().slice(0, 10);

// Converts a local date+time string in a given IANA timezone to a UTC Date.
// Same algorithm as tools.js localToUtc — kept inline to avoid coupling.
function localToUtcForReminder(dateStr, timeStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min]  = timeStr.split(':').map(Number);
  const pseudo    = new Date(Date.UTC(y, m - 1, d, h, min));
  const parts     = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(pseudo);
  const p = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  const tzAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  return new Date(pseudo.getTime() - (tzAsUtcMs - pseudo.getTime()));
}

async function handleEntityCreate(req, res) {
  const verifiedUid = await requireAuth(req, res);
  if (!verifiedUid) return;

  const { entityType, data, docId } = req.body ?? {};
  // userId from body is deliberately ignored — verifiedUid from token is used
  const userId = verifiedUid;

  if (!entityType || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing entityType or data' });
  }

  const collection = ENTITY_COLLECTION_MAP[entityType];
  if (!collection) {
    return res.status(400).json({ error: `Unknown entityType: ${entityType}` });
  }

  // Transactions: money fields are decided server-side by the shared service
  // (client-sent rubAmount / fx / schemaVersion are ignored — never trusted).
  if (entityType === 'transaction') {
    try {
      const created = await createFinancialTransaction({
        uid: userId,
        docId: docId ? String(docId) : undefined,
        type: data.type,
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        date: typeof data.date === 'string' ? data.date : undefined,
        categoryId: data.categoryId,
        category: data.category,
        bank: data.bank,
        goalId: data.goalId,
        source: 'web-app',
      }, {
        persist: (uid, doc, id) => createEntityInFirestore(uid, 'transaction', doc, id),
      });
      if (!created.ok) {
        return res.status(429).json({
          error: 'Limit exceeded', code: 'free_limit',
          limit: created.limit, current: created.current,
        });
      }
      const t = created.transaction;
      return res.status(200).json({
        ok: true, id: created.id,
        transaction: { amount: t.amount, currency: t.currency, rubAmount: t.rubAmount, fx: t.fx, schemaVersion: t.schemaVersion },
      });
    } catch (err) {
      if (err instanceof FxUnavailableError) {
        return res.status(503).json({ error: 'FX unavailable', code: 'fx_unavailable', currency: err.currency });
      }
      if (err instanceof TransactionValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error('[ai/entityCreate] transaction error:', err.message);
      return res.status(500).json({ error: 'Failed to create entity' });
    }
  }

  const cfg       = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collection).doc(String(docId))
    : db.collection(collection).doc();
  const now     = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = { ...data, userId, createdAt: now, updatedAt: now };

  try {
    const plan   = await getActivePlan(userId);
    const isFree = plan === 'free';

    if (isFree && cfg) {
      const counterRef = db.collection('users').doc(userId)
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

        tx.set(entityRef, baseDoc);

        const counterPatch = { userId, [cfg.field]: used + 1, updatedAt: now };
        if (win !== null) counterPatch[cfg.windowField] = win;
        tx.set(counterRef, counterPatch, { merge: true });
      });

      if (limitExceeded) {
        return res.status(429).json({
          error: 'Limit exceeded', code: 'free_limit',
          limit: cfg.limit, current: currentCount,
        });
      }
    } else {
      await entityRef.set(baseDoc);
    }

    // Create a reminder in Firestore when a task has a specific time set.
    // The cron (api/telegram/cron.js or Firebase sendDueReminders) will pick it up.
    if (entityType === 'task' && data.time && data.date) {
      try {
        const userSnap = await db.collection('users').doc(userId).get();
        const ud       = userSnap.exists ? userSnap.data() : {};
        const chatId   = ud.chatId || ud.telegramId;
        if (chatId) {
          const tz          = (ud.timezone && ud.timezone.includes('/')) ? ud.timezone : 'Europe/Moscow';
          const scheduledAt = localToUtcForReminder(data.date, data.time, tz);
          if (scheduledAt > new Date()) {
            await db.collection('reminders').doc().set({
              userId,
              chatId,
              title:        data.title || '',
              scheduledAt:  admin.firestore.Timestamp.fromDate(scheduledAt),
              status:       'pending',
              telegramText: `Задача: ${data.title || ''}`,
              taskId:       entityRef.id,
              source:       'web-app',
              createdAt:    admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log('[entityCreate] reminder created for task', entityRef.id, 'at', scheduledAt.toISOString());
          }
        }
      } catch (reminderErr) {
        console.error('[entityCreate] reminder creation failed:', reminderErr.message);
      }
    }

    return res.status(200).json({ ok: true, id: entityRef.id });
  } catch (err) {
    console.error('[ai/entityCreate] error:', err.message);
    return res.status(500).json({ error: 'Failed to create entity' });
  }
}

// Transaction edit — the only path that may change money fields of an
// existing transaction. Semantics live in buildTransactionUpdate.
async function handleTransactionUpdate(req, res) {
  const verifiedUid = await requireAuth(req, res);
  if (!verifiedUid) return;

  const { id, patch } = req.body ?? {};
  if (!id || typeof id !== 'string' || !patch || typeof patch !== 'object') {
    return res.status(400).json({ error: 'Missing id or patch' });
  }

  try {
    const ref  = db.collection('transactions').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== verifiedUid) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    const userSnap = await db.collection('users').doc(verifiedUid).get();
    const userCurrency = userSnap.exists ? userSnap.data().currency : null;

    const updates = await buildTransactionUpdate({ existing: snap.data(), patch, userCurrency });
    if (Object.keys(updates).length) {
      await ref.update({ ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    const merged = { ...snap.data(), ...updates };
    return res.status(200).json({
      ok: true, id,
      transaction: { amount: merged.amount, currency: merged.currency, rubAmount: merged.rubAmount, fx: merged.fx || null, schemaVersion: merged.schemaVersion },
    });
  } catch (err) {
    if (err instanceof FxUnavailableError) {
      return res.status(503).json({ error: 'FX unavailable', code: 'fx_unavailable', currency: err.currency });
    }
    if (err instanceof TransactionValidationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[ai/transactionUpdate] error:', err.message);
    return res.status(500).json({ error: 'Failed to update transaction' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Savings goals — server-owned writes (clients only read via Firestore rules).
// Web-created goals are in the budget currency (RUB); goals created elsewhere
// (Telegram) keep their own `currency`, and deposits are always in that
// goal's currency, so no FX is ever involved.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_GOAL_AMOUNT = 1_000_000_000;
const isPosNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_GOAL_AMOUNT;
const round2 = (n) => Math.round(n * 100) / 100;

async function handleGoalCreate(req, res) {
  const uid = await requireAuth(req, res);
  if (!uid) return;
  const { title, targetAmount, deadline } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim() || title.length > 120) {
    return res.status(400).json({ error: 'Invalid title', code: 'VALIDATION_ERROR' });
  }
  if (!isPosNum(targetAmount)) {
    return res.status(400).json({ error: 'Invalid targetAmount', code: 'VALIDATION_ERROR' });
  }
  if (deadline != null && deadline !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(deadline))) {
    return res.status(400).json({ error: 'Invalid deadline', code: 'VALIDATION_ERROR' });
  }
  try {
    const ref = db.collection('goals').doc();
    await ref.set({
      userId: uid,
      title: title.trim(),
      targetAmount: round2(targetAmount),
      currentAmount: 0,
      currency: HOME_BUDGET_CURRENCY,
      deadline: deadline ? String(deadline) : null,
      category: null,
      source: 'web-app',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, id: ref.id });
  } catch (err) {
    console.error('[ai/goalCreate] error:', err.message);
    return res.status(500).json({ error: 'Failed to create goal' });
  }
}

// direction: 'deposit' adds, 'withdraw' subtracts (never below 0)
async function handleGoalAdjust(req, res) {
  const uid = await requireAuth(req, res);
  if (!uid) return;
  const { id, amount, direction } = req.body ?? {};
  if (typeof id !== 'string' || !id || !isPosNum(amount) || !['deposit', 'withdraw'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR' });
  }
  try {
    const ref = db.collection('goals').doc(id);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().userId !== uid) return { notFound: true };
      const current = Number(snap.data().currentAmount) || 0;
      if (direction === 'withdraw' && amount > current) return { insufficient: true, current };
      const next = round2(direction === 'deposit' ? current + amount : current - amount);
      tx.update(ref, { currentAmount: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { next };
    });
    if (out.notFound) return res.status(404).json({ error: 'Goal not found' });
    if (out.insufficient) return res.status(400).json({ error: 'Insufficient goal balance', code: 'INSUFFICIENT', current: out.current });
    return res.status(200).json({ ok: true, id, currentAmount: out.next });
  } catch (err) {
    console.error('[ai/goalAdjust] error:', err.message);
    return res.status(500).json({ error: 'Failed to update goal' });
  }
}

async function handleGoalDelete(req, res) {
  const uid = await requireAuth(req, res);
  if (!uid) return;
  const { id } = req.body ?? {};
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR' });
  try {
    const ref = db.collection('goals').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== uid) return res.status(404).json({ error: 'Goal not found' });
    await ref.delete();
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[ai/goalDelete] error:', err.message);
    return res.status(500).json({ error: 'Failed to delete goal' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Admin helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireAdmin(req, res) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.headers['x-admin-key'] !== key) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

async function handleAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;

  const now          = new Date();
  const todayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart    = new Date(now.getTime() - 7 * 86400000);
  const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyAgo    = new Date(now.getTime() - 30 * 86400000);
  const monthKey     = now.toISOString().slice(0, 7);

  const [usersSnap, subsSnap, paymentsSnap, referrersSnap, aiSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('subscriptions').get(),
    db.collection('payments').where('status', 'in', ['CONFIRMED', 'confirmed']).get(),
    db.collection('referrers').get(),
    db.collection('aiUsage').where('month', '==', monthKey).get(),
  ]);

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

  const planDist   = { free: usersSnap.size, pro: 0, premium: 0 };
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

  let pendingPayouts = 0;
  const topReferrers = [];
  referrersSnap.docs.forEach(d => {
    const data = { id: d.id, ...d.data() };
    pendingPayouts += data.pendingPayout || 0;
    topReferrers.push(data);
  });
  topReferrers.sort((a, b) => (b.totalEarned || 0) - (a.totalEarned || 0));

  let aiRequestsMonth = 0;
  aiSnap.docs.forEach(d => {
    const data = d.data();
    aiRequestsMonth += (data.textRequests || 0) + (data.imageRequests || 0) + (data.pdfReports || 0);
  });

  // Recent confirmed payments (last 10) — may need composite index; non-fatal
  let recentPayments = [];
  try {
    const recentPaymentsSnap = await db.collection('payments')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    recentPayments = recentPaymentsSnap.docs
      .filter(d => ['CONFIRMED', 'confirmed'].includes(d.data().status))
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

  // Recent registrations (last 10)
  const recentUsersSnap = await db.collection('users').orderBy('createdAt', 'desc').limit(10).get();
  const recentUsers = recentUsersSnap.docs.map(d => ({
    uid:         d.id,
    displayName: d.data().displayName || d.data().first_name || '',
    username:    d.data().username || '',
    createdAt:   d.data().createdAt?.toDate?.()?.toISOString?.() || '',
  }));

  return res.status(200).json({
    totalUsers: usersSnap.size, payingUsers,
    newToday, newWeek, newMonth,
    revenueMonth, pendingPayouts, aiRequestsMonth,
    topReferrers: topReferrers.slice(0, 5),
    regsByDay, revByDay, planDist,
    recentPayments, recentUsers,
  });
}

async function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = req.body ?? {};

  // Diagnostic — call with { action: 'debug' } to see raw Firestore state
  if (body.action === 'debug') {
    const countSnap = await db.collection('users').limit(5).get();
    const sample = countSnap.docs.map(d => {
      const data = d.data();
      // Expose full raw doc so we can see nested field values
      const raw = {};
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && v.constructor?.name === 'Timestamp') {
          raw[k] = v.toDate().toISOString();
        } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          raw[k] = v; // show nested objects (telegramUser, subscription, etc.)
        } else {
          raw[k] = v;
        }
      }
      return { id: d.id, data: raw };
    });
    return res.status(200).json({ ok: true, collectionSize: countSnap.size, sample });
  }

  if (body.action) {
    const { action, userId, ...params } = body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'grant_subscription') {
      const { plan = 'pro', periodMonths = 1 } = params;
      let expiresAt = new Date();
      const subSnap = await db.collection('subscriptions').doc(userId).get();
      if (subSnap.exists) {
        const ex = subSnap.data().expiresAt?.toDate?.() || (subSnap.data().endDateMs && new Date(subSnap.data().endDateMs));
        if (ex && ex > expiresAt) expiresAt = ex;
      }
      expiresAt.setMonth(expiresAt.getMonth() + Number(periodMonths));
      await db.collection('subscriptions').doc(userId).set({
        userId, plan, status: 'active',
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        endDateMs: expiresAt.getTime(),
        updatedAt: now, grantedByAdmin: true,
      }, { merge: true });
      await db.collection('users').doc(userId).set({ isPro: true, updatedAt: now }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'send_message') {
      const { text } = params;
      if (!text) return res.status(400).json({ error: 'text required' });
      const userSnap = await db.collection('users').doc(userId).get();
      if (!userSnap.exists) return res.status(404).json({ error: 'user_not_found' });
      const chatId = userSnap.data().chatId || userSnap.data().telegramId;
      if (!chatId) return res.status(400).json({ error: 'no_telegram_id' });
      const token  = process.env.TELEGRAM_BOT_TOKEN;
      const tgRes  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
      const tgData = await tgRes.json();
      return res.status(200).json({ ok: tgData.ok, error: tgData.description });
    }

    if (action === 'block') {
      await db.collection('users').doc(userId).set({ status: 'blocked', updatedAt: now }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'unblock') {
      await db.collection('users').doc(userId).set({ status: 'active', updatedAt: now }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  const { limit: lim = 200, search } = body;
  const limit = Math.min(Number(lim) || 200, 500);

  // Firestore orderBy('createdAt') excludes docs without that field entirely.
  // Fetch without ordering and sort in JS so all users are always returned.
  const snap = await db.collection('users').limit(limit).get();

  let subsMap = new Map();
  try {
    const subsSnap = await db.collection('subscriptions').get();
    subsMap = new Map(subsSnap.docs.map(d => [d.id, d.data()]));
  } catch {
    // subscriptions join is non-fatal — show users without plan info
  }

  const now = Date.now();
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;

  // Collect chatIds that have no username stored — fetch from Telegram in bulk
  const needTgLookup = [];
  snap.docs.forEach(d => {
    const data = d.data();
    const chatId = data.chatId || data.telegramId;
    if (chatId && !data.username && !data.firstName && !data.first_name) {
      needTgLookup.push({ docId: d.id, chatId });
    }
  });

  // Fetch Telegram user info for up to 30 users (avoid rate limits)
  const tgInfoMap = new Map();
  if (tgToken && needTgLookup.length > 0) {
    const batch = needTgLookup.slice(0, 30);
    await Promise.allSettled(batch.map(async ({ docId, chatId }) => {
      try {
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/getChat?chat_id=${chatId}`);
        const j = await r.json();
        if (j.ok && j.result) {
          tgInfoMap.set(docId, j.result);
          // Persist so we don't re-fetch next time
          await db.collection('users').doc(docId).set({
            firstName: j.result.first_name || '',
            lastName:  j.result.last_name  || '',
            username:  j.result.username   || '',
          }, { merge: true });
        }
      } catch { /* non-fatal */ }
    }));
  }

  let users = snap.docs.map(d => {
    const data    = d.data();
    const tgLive  = tgInfoMap.get(d.id) || {};

    // subscription may be embedded in user doc OR in separate subscriptions collection
    const embeddedSub = data.subscription && typeof data.subscription === 'object' ? data.subscription : null;
    const sub  = subsMap.get(d.id) || embeddedSub;
    const endMs = sub?.endDateMs
      ?? (sub?.endDate ? new Date(sub.endDate).getTime() : 0)
      ?? sub?.expiresAt?.toMillis?.()
      ?? 0;
    const subActive = sub?.status === 'active' && (!endMs || endMs > now);
    const plan = subActive ? (sub?.plan || sub?.trialPlan || 'pro') : (data.isPro ? 'pro' : 'free');
    const createdMs = data.createdAt?.toMillis?.() ?? data.createdAt?.toDate?.()?.getTime?.() ?? 0;
    return {
      uid:          d.id,
      displayName:  data.displayName || data.firstName || data.first_name || data.name
                    || tgLive.first_name || '',
      email:        data.email || '',
      telegramId:   String(data.telegramId || data.chatId || ''),
      username:     data.username || tgLive.username || '',
      status:       data.status || 'active',
      isPro:        data.isPro || false,
      plan,
      subExpiresAt: endMs ? new Date(endMs).toISOString() : '',
      referralCode: data.referredByInfluencer || data.referralCode || '',
      createdAt:    createdMs ? new Date(createdMs).toISOString() : '',
      createdMs,
    };
  });

  // Sort newest-first in JS (handles mixed createdAt presence)
  users.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
  users = users.map(({ createdMs: _ms, ...u }) => u); // strip internal sort key

  if (search) {
    const s = search.toLowerCase();
    users = users.filter(u =>
      u.displayName.toLowerCase().includes(s) ||
      u.email.toLowerCase().includes(s) ||
      u.telegramId.includes(s) ||
      u.username.toLowerCase().includes(s) ||
      u.uid.toLowerCase().includes(s)
    );
  }

  return res.status(200).json({ ok: true, users, total: users.length, hasMore: snap.size === limit });
}

async function handleAdminSubscriptions(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = req.body ?? {};

  if (body.action === 'update') {
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
      paymentMethod: data.paymentMethod,
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

async function handleAdminReferrals(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = req.body ?? {};

  if (body.action === 'create') {
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

  if (body.action === 'update') {
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

  if (body.action === 'payout') {
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
  const { seedAllPromoCodes } = require('../_lib/promoCodes');
  await seedAllPromoCodes();

  const snap  = await db.collection('promoCodes').get();
  const codes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return res.status(200).json({ ok: true, codes });
}

async function handleAdminMessages(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = req.body ?? {};

  if (body.action === 'history') {
    const snap = await db.collection('adminMessages').orderBy('sentAt', 'desc').limit(50).get();
    const msgs = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      sentAt: d.data().sentAt?.toDate?.()?.toISOString?.() || '',
    }));
    return res.status(200).json({ ok: true, messages: msgs });
  }

  const { text, target = 'all' } = body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });

  let chatIds = [];

  if (Array.isArray(target)) {
    const snaps = await Promise.all(target.map(uid => db.collection('users').doc(uid).get()));
    chatIds = snaps
      .filter(s => s.exists)
      .map(s => s.data().chatId || s.data().telegramId)
      .filter(Boolean);
  } else {
    const usersSnap = await db.collection('users').get();
    if (target === 'all') {
      chatIds = usersSnap.docs
        .map(d => d.data().chatId || d.data().telegramId)
        .filter(Boolean);
    } else {
      const subsSnap = await db.collection('subscriptions').where('status', '==', 'active').get();
      const activeSubs = new Map(subsSnap.docs.map(d => [d.id, d.data()]));
      chatIds = usersSnap.docs.filter(d => {
        const sub  = activeSubs.get(d.id);
        const endMs = sub?.endDateMs ?? sub?.expiresAt?.toMillis?.() ?? 0;
        if (endMs && endMs < Date.now()) return target === 'free';
        const plan = sub?.plan || 'free';
        return plan === target;
      }).map(d => d.data().chatId || d.data().telegramId).filter(Boolean);
    }
  }

  // Deduplicate: same Telegram user may have multiple Firestore docs (anon + custom token)
  chatIds = [...new Set(chatIds.map(id => String(id)))];

  let sent = 0, failed = 0;
  const BATCH_SIZE = 30;
  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    const chunk = chatIds.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(chunk.map(async chatId => {
      try {
        const r    = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
        const data = await r.json();
        if (data.ok) sent++; else failed++;
      } catch { failed++; }
    }));
    if (i + BATCH_SIZE < chatIds.length) await new Promise(r => setTimeout(r, 1000));
  }

  await db.collection('adminMessages').add({
    text, target: typeof target === 'string' ? target : 'custom',
    total: chatIds.length, sent, failed,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return res.status(200).json({ ok: true, total: chatIds.length, sent, failed });
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

// ─────────────────────────────────────────────────────────────────────────────
// Admin: TOTP 2FA — verify and setup
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdminVerifyOtp(req, res) {
  // API key must be valid to even attempt OTP verification
  if (!requireAdmin(req, res)) return;

  const secret = process.env.ADMIN_TOTP_SECRET;

  if (!secret) {
    // 2FA not configured — return ok so login can proceed without TOTP
    return res.status(200).json({ ok: true, required: false });
  }

  const { token } = req.body ?? {};
  if (!token) {
    return res.status(200).json({ ok: false, required: true, error: 'token_required' });
  }

  const valid = verifyTotp(secret, String(token));
  return res.status(200).json({ ok: valid, required: true, error: valid ? null : 'invalid_token' });
}

async function handleAdminSetupOtp(req, res) {
  if (!requireAdmin(req, res)) return;

  const existingSecret = process.env.ADMIN_TOTP_SECRET;
  // Use existing secret (to show on another device) or generate a new candidate
  const secret = existingSecret || generateTotpSecret();
  const uri    = `otpauth://totp/Enma%20Admin?secret=${secret}&issuer=Enma&algorithm=SHA1&digits=6&period=30`;

  // If admin sends a test token, verify it against the secret in the request body
  const { testToken, candidateSecret } = req.body ?? {};
  if (testToken) {
    const s     = candidateSecret || existingSecret || '';
    const valid = s ? verifyTotp(s, String(testToken)) : false;
    return res.status(200).json({ ok: valid, error: valid ? null : 'invalid_token' });
  }

  return res.status(200).json({
    ok:                 true,
    secret,
    uri,
    alreadyConfigured:  !!existingSecret,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral: validate influencer or user referral code
// ─────────────────────────────────────────────────────────────────────────────

async function handleReferralValidate(req, res) {
  const verifiedUid = await requireAuth(req, res);
  if (!verifiedUid) return;

  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ valid: false, error: 'missing_code' });

  // Try influencer code first
  const { validateInfluencerCode } = require('../_lib/referral/influencer');
  const influencerResult = await validateInfluencerCode(code, verifiedUid);
  if (influencerResult.valid) {
    return res.status(200).json(influencerResult);
  }

  // Try user referral code (8-char code from users.referralCode)
  const { findUserByReferralCode } = require('../_lib/referral/codes');
  const referrer = await findUserByReferralCode(code);
  if (!referrer) {
    return res.status(200).json({ valid: false, error: 'code_not_found' });
  }

  // Self-referral check (uses verified uid — cannot be spoofed)
  if (referrer.id === verifiedUid) {
    return res.status(200).json({ valid: false, error: 'self_referral' });
  }

  // Check if user already has a referrer
  const userSnap = await db.collection('users').doc(verifiedUid).get();
  if (userSnap.exists && userSnap.data().referredBy) {
    return res.status(200).json({ valid: false, error: 'already_referred' });
  }

  return res.status(200).json({ valid: true, discountPercent: 0, type: 'user' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral: fetch referral info for a user (ensures referralCode exists)
// ─────────────────────────────────────────────────────────────────────────────

async function handleReferralInfo(req, res) {
  const verifiedUid = await requireAuth(req, res);
  if (!verifiedUid) return;
  const userId = verifiedUid;

  const { ensureReferralCode } = require('../_lib/referral/codes');
  const code = await ensureReferralCode(userId);

  const userSnap = await db.collection('users').doc(userId).get();
  const userData = userSnap.exists ? userSnap.data() : {};

  const botUsername   = process.env.TELEGRAM_BOT_USERNAME || 'EnmaAI_bot';
  const referralLink  = code ? `https://t.me/${botUsername}?start=ref_${code}` : (userData.referralLink || null);

  // Count referrals this user has made
  const referralsSnap = await db.collection('referrals').where('referrerId', '==', userId).get();

  return res.status(200).json({
    ok:                     true,
    referralCode:           code || userData.referralCode || null,
    referralLink,
    referralBalance:        userData.referralBalance        || 0,
    totalReferralEarnedRub: userData.totalReferralEarnedRub || 0,
    referredBy:             userData.referredBy             || null,
    totalReferred:          referralsSnap.size,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral: admin payout management (X-Admin-Key required)
// POST { listOnly: true, minAmount? }        → list pending referrers
// POST { referrerId, amount }                → mark earnings paid
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.query;

  try {
    switch (action) {
      case 'entityCreate':     return await handleEntityCreate(req, res);
      case 'transactionUpdate': return await handleTransactionUpdate(req, res);
      case 'goalCreate':       return await handleGoalCreate(req, res);
      case 'goalAdjust':       return await handleGoalAdjust(req, res);
      case 'goalDelete':       return await handleGoalDelete(req, res);
      case 'referralValidate':      return await handleReferralValidate(req, res);
      case 'referralInfo':          return await handleReferralInfo(req, res);
      case 'referralPayout':        return await handleReferralPayout(req, res);
      case 'adminVerifyOtp':        return await handleAdminVerifyOtp(req, res);
      case 'adminSetupOtp':         return await handleAdminSetupOtp(req, res);
      case 'adminStats':            return await handleAdminStats(req, res);
      case 'adminUsers':            return await handleAdminUsers(req, res);
      case 'adminSubscriptions':    return await handleAdminSubscriptions(req, res);
      case 'adminPayments':         return await handleAdminPayments(req, res);
      case 'adminReferrals':        return await handleAdminReferrals(req, res);
      case 'adminPromoCodes':       return await handleAdminPromoCodes(req, res);
      case 'adminMessages':         return await handleAdminMessages(req, res);
      case 'adminAiUsage':          return await handleAdminAiUsage(req, res);
      default:
        return res.status(404).json({ error: `Unknown AI action: ${action}` });
    }
  } catch (err) {
    console.error(`[ai/${action}] unhandled error:`, err.message, err.stack);
    if (err.statusCode === 503) {
      return res.status(503).json({ error: 'AI перегружен, повторите через минуту' });
    }
    const isAdmin = String(action).startsWith('admin');
    return res.status(500).json({ error: isAdmin ? err.message : 'Internal server error' });
  }
};
