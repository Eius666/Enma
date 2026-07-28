'use strict';

// Referral payout cron — runs on the 1st of each month at 00:00 UTC.
// Finds all users with pendingPayoutUsd > 0 and:
//   - If no TON wallet: notifies the user to set one.
//   - If wallet set: creates referral_payouts doc, marks earnings as paid,
//     resets pendingPayoutUsd, and notifies the user.
// Actual TON transfer is currently manual (admin receives payout summary).
// When TON_PAYMENT_MNEMONIC is set, auto-transfer can be wired in here.

const { db, admin } = require('../_lib/firebaseAdmin');
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
  }).catch(err => console.error('[referral-payouts] notify error:', err.message));
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const token      = process.env.TELEGRAM_BOT_TOKEN;
  const adminChat  = process.env.CONTENT_ADMIN_CHAT_ID;

  try {
    const tonRate = await getTonRateUsd();

    // Single equality filter — no composite index needed
    const usersSnap = await db.collection('users')
      .where('pendingPayoutUsd', '>', 0)
      .get();

    const results = [];

    for (const userDoc of usersSnap.docs) {
      const ud     = userDoc.data();
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

      // Create payout record
      const payoutRef = db.collection('referral_payouts').doc();
      const payoutId  = payoutRef.id;

      await payoutRef.set({
        referrerId:       userId,
        tonWalletAddress: ud.tonWalletAddress,
        totalUsd:         pendingUsd,
        totalTon,
        earningsCount:    0,
        status:           'pending',
        txHash:           null,
        createdAt:        admin.firestore.FieldValue.serverTimestamp(),
        sentAt:           null,
        errorMessage:     null,
      });

      // Mark all pending earnings as paid in a batch
      const earningsSnap = await db.collection('referral_earnings')
        .where('referrerId', '==', userId)
        .where('status', '==', 'pending')
        .get();

      if (earningsSnap.size > 0) {
        const batch = db.batch();
        for (const earnDoc of earningsSnap.docs) {
          batch.update(earnDoc.ref, {
            status:        'paid',
            paidAt:        admin.firestore.FieldValue.serverTimestamp(),
            payoutBatchId: payoutId,
          });
        }
        await batch.commit();
        await payoutRef.update({ earningsCount: earningsSnap.size });
      }

      // Reset user balance
      await userDoc.ref.update({
        totalPaidUsd:    admin.firestore.FieldValue.increment(pendingUsd),
        pendingPayoutUsd: 0,
      });

      // Notify admin to send TON manually (or auto-transfer via SDK when wired)
      await tgNotify(token, adminChat,
        `📤 Реферальная выплата:\n` +
        `👤 userId: <code>${userId}</code>\n` +
        `💳 Кошелёк: <code>${ud.tonWalletAddress}</code>\n` +
        `💰 <b>${totalTon} TON</b> ($${pendingUsd.toFixed(2)})\n` +
        `🆔 Payout: <code>${payoutId}</code>`
      );

      // Notify user
      await tgNotify(token, chatId,
        `💸 Выплата ${totalTon} TON ($${pendingUsd.toFixed(2)}) отправлена на обработку.\n` +
        `Адрес: <code>${ud.tonWalletAddress}</code>\n\n` +
        `Средства поступят в течение 1–2 рабочих дней.`
      );

      results.push({ userId, status: 'pending', pendingUsd, totalTon, payoutId });
    }

    res.status(200).json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error('[referral-payouts] fatal:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
