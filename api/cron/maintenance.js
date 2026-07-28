'use strict';

// Consolidated maintenance cron — one function, multiple operations.
// Trigger by ?type= parameter:
//   ?type=cleanup           — delete old messages (daily, 03:00 UTC)
//   ?type=migrate-timezone  — one-shot: add default TZ to all users
//   ?type=referral-payouts  — monthly referral payouts (1st of month 00:00 UTC)
//   (default / no type)     — referral-payouts (for backward-compat)

const { db, admin } = require('../_lib/firebaseAdmin');
const { checkSubscription } = require('../_lib/ai/subscription');
const { getTonRateUsd } = require('../_lib/referral/ton-rate');

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerOk = req.headers.authorization === `Bearer ${secret}`;
  const queryOk  = req.query?.secret === secret;
  return headerOk || queryOk;
}

const TG = 'https://api.telegram.org';
async function tgNotify(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`${TG}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── Cleanup: delete old messages ──────────────────────────────────────────────

async function runCleanup() {
  const FREE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const PRO_MAX_AGE_MS  = 90 * 24 * 60 * 60 * 1000;
  const BATCH_SZ        = 400;
  const now = Date.now();
  let totalDeleted = 0;

  const cutoff30 = admin.firestore.Timestamp.fromDate(new Date(now - FREE_MAX_AGE_MS));
  const cutoff90 = admin.firestore.Timestamp.fromDate(new Date(now - PRO_MAX_AGE_MS));

  // Pass 1: everyone's messages older than 90 days
  const old90 = await db.collection('messages').where('createdAt', '<', cutoff90).limit(500).get();
  let batch = db.batch(); let n = 0;
  for (const doc of old90.docs) {
    batch.delete(doc.ref);
    if (++n % BATCH_SZ === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % BATCH_SZ !== 0) await batch.commit();
  totalDeleted += n;

  // Pass 2: messages 30-90 days old — delete only for free users
  const mid = await db.collection('messages')
    .where('createdAt', '>=', cutoff90)
    .where('createdAt', '<',  cutoff30)
    .limit(500)
    .get();

  // Group by userId
  const byUser = new Map();
  for (const doc of mid.docs) {
    const uid = doc.data().userId;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(doc);
  }

  batch = db.batch(); n = 0;
  for (const [uid, docs] of byUser.entries()) {
    const sub = await checkSubscription(uid).catch(() => ({ active: false }));
    if (sub.active) continue;
    for (const doc of docs) {
      batch.delete(doc.ref);
      if (++n % BATCH_SZ === 0) { await batch.commit(); batch = db.batch(); }
    }
  }
  if (n % BATCH_SZ !== 0) await batch.commit();
  totalDeleted += n;

  return { type: 'cleanup', deleted: totalDeleted };
}

// ── Migrate timezone: set default TZ for users that don't have one ────────────

async function runMigrateTimezone() {
  const DEFAULT_TZ = 'Europe/Warsaw';
  const BATCH_SZ = 400;
  let updated = 0; let skipped = 0;

  const snap = await db.collection('users').get();
  let batch = db.batch(); let n = 0;
  for (const doc of snap.docs) {
    if (doc.data().timezone) { skipped++; continue; }
    batch.set(doc.ref, {
      timezone:            DEFAULT_TZ,
      timezoneConfidence:  'default',
      timezoneInferredFrom: null,
    }, { merge: true });
    updated++;
    if (++n % BATCH_SZ === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % BATCH_SZ !== 0) await batch.commit();

  return { type: 'migrate-timezone', updated, skipped, total: snap.size };
}

// ── Referral payouts: monthly transfer ───────────────────────────────────────

async function runReferralPayouts(token, adminChat) {
  const tonRate = await getTonRateUsd();
  const usersSnap = await db.collection('users').where('pendingPayoutUsd', '>', 0).get();
  const results = [];

  for (const userDoc of usersSnap.docs) {
    const ud = userDoc.data();
    const userId = userDoc.id;
    const chatId = ud.chatId;
    const pendingUsd = Number(ud.pendingPayoutUsd) || 0;
    if (pendingUsd <= 0) continue;

    if (!ud.tonWalletAddress) {
      await tgNotify(token, chatId,
        `💰 У тебя накопилось <b>$${pendingUsd.toFixed(2)}</b> реферальных выплат!\n\n` +
        `Укажи TON кошелёк командой /wallet — и деньги придут в следующем месяце.`
      );
      results.push({ userId, status: 'no_wallet', pendingUsd });
      continue;
    }

    const totalTon = Math.round((pendingUsd / tonRate) * 10000) / 10000;
    const payoutRef = db.collection('referral_payouts').doc();
    const payoutId  = payoutRef.id;

    await payoutRef.set({
      referrerId: userId, tonWalletAddress: ud.tonWalletAddress,
      totalUsd: pendingUsd, totalTon, earningsCount: 0,
      status: 'pending', txHash: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      sentAt: null, errorMessage: null,
    });

    const earningsSnap = await db.collection('referral_earnings')
      .where('referrerId', '==', userId).where('status', '==', 'pending').get();

    if (earningsSnap.size > 0) {
      const batch = db.batch();
      for (const e of earningsSnap.docs) {
        batch.update(e.ref, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), payoutBatchId: payoutId });
      }
      await batch.commit();
      await payoutRef.update({ earningsCount: earningsSnap.size });
    }

    await userDoc.ref.update({
      totalPaidUsd:    admin.firestore.FieldValue.increment(pendingUsd),
      pendingPayoutUsd: 0,
    });

    await tgNotify(token, adminChat,
      `📤 Реферальная выплата:\n👤 <code>${userId}</code>\n` +
      `💳 <code>${ud.tonWalletAddress}</code>\n` +
      `💰 <b>${totalTon} TON</b> ($${pendingUsd.toFixed(2)})\n🆔 <code>${payoutId}</code>`
    );

    await tgNotify(token, chatId,
      `💸 Выплата ${totalTon} TON ($${pendingUsd.toFixed(2)}) отправлена на обработку.\n` +
      `Адрес: <code>${ud.tonWalletAddress}</code>\n\nСредства поступят в течение 1–2 рабочих дней.`
    );

    results.push({ userId, status: 'pending', pendingUsd, totalTon, payoutId });
  }

  return { type: 'referral-payouts', processed: results.length, results };
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const type     = req.query?.type || 'referral-payouts';
  const token    = process.env.TELEGRAM_BOT_TOKEN;
  const adminChat = process.env.CONTENT_ADMIN_CHAT_ID;

  try {
    let result;
    if (type === 'cleanup')           result = await runCleanup();
    else if (type === 'migrate-timezone') result = await runMigrateTimezone();
    else                              result = await runReferralPayouts(token, adminChat);

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[maintenance] fatal:', type, err.message);
    res.status(500).json({ ok: false, type, error: err.message });
  }
};
