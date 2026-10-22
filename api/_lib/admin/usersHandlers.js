'use strict';

// Admin user management — POST /api/ai/adminUsers.
//   { action: 'debug' }                                → raw sample of users docs
//   { action: 'grant_subscription'|'send_message'|'block'|'unblock', userId, … }
//   { limit?, search? }                                → user list with plan info
// Built by the api/ai router (see api/ai/[action].js).

const TELEGRAM_LOOKUP_MAX = 30; // Telegram user info fetched per list call (rate limits)

function createUsersHandlers(ctx) {
  const { db, admin, requireAdmin } = ctx;

  // Diagnostic — call with { action: 'debug' } to see raw Firestore state
  async function adminUsersDebug(res) {
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

  async function grantSubscription(res, userId, params, now) {
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

  async function sendMessageToUser(res, userId, params) {
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

  async function setUserStatus(res, userId, status, now) {
    await db.collection('users').doc(userId).set({ status, updatedAt: now }, { merge: true });
    return res.status(200).json({ ok: true });
  }

  async function adminUserAction(res, body) {
    const { action, userId, ...params } = body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'grant_subscription') return grantSubscription(res, userId, params, now);
    if (action === 'send_message')       return sendMessageToUser(res, userId, params);
    if (action === 'block')              return setUserStatus(res, userId, 'blocked', now);
    if (action === 'unblock')            return setUserStatus(res, userId, 'active', now);

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  // subscription join is non-fatal — users are shown without plan info
  async function loadSubscriptionsMap() {
    let subsMap = new Map();
    try {
      const subsSnap = await db.collection('subscriptions').get();
      subsMap = new Map(subsSnap.docs.map(d => [d.id, d.data()]));
    } catch {
      // subscriptions join is non-fatal — show users without plan info
    }
    return subsMap;
  }

  // Users with a chat id but no stored name: fetch their Telegram profile (up
  // to TELEGRAM_LOOKUP_MAX per call) and persist it so it is not re-fetched.
  async function lookupTelegramProfiles(snap, tgToken) {
    const needTgLookup = [];
    snap.docs.forEach(d => {
      const data = d.data();
      const chatId = data.chatId || data.telegramId;
      if (chatId && !data.username && !data.firstName && !data.first_name) {
        needTgLookup.push({ docId: d.id, chatId });
      }
    });

    const tgInfoMap = new Map();
    if (tgToken && needTgLookup.length > 0) {
      const batch = needTgLookup.slice(0, TELEGRAM_LOOKUP_MAX);
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
    return tgInfoMap;
  }

  function toAdminUserRow(d, subsMap, tgInfoMap, now) {
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
  }

  async function listAdminUsers(res, body) {
    const { limit: lim = 200, search } = body;
    const limit = Math.min(Number(lim) || 200, 500);

    // Firestore orderBy('createdAt') excludes docs without that field entirely.
    // Fetch without ordering and sort in JS so all users are always returned.
    const snap = await db.collection('users').limit(limit).get();

    const subsMap = await loadSubscriptionsMap();

    const now = Date.now();
    const tgInfoMap = await lookupTelegramProfiles(snap, process.env.TELEGRAM_BOT_TOKEN);

    let users = snap.docs.map(d => toAdminUserRow(d, subsMap, tgInfoMap, now));

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

  async function handleAdminUsers(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};
    if (body.action === 'debug') return adminUsersDebug(res);
    if (body.action) return adminUserAction(res, body);
    return listAdminUsers(res, body);
  }

  return { handleAdminUsers };
}

module.exports = { createUsersHandlers };
