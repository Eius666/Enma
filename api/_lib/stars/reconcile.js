'use strict';

// Manual/admin reconciliation between Telegram's own Stars ledger and Enma's
// `payments` collection (Telegram Stars Audit §16). Not wired to a cron or a
// public endpoint — run it ad hoc (e.g. from a one-off script or the Node
// REPL) until there's a real decision about scheduling and who gets to see
// the output.
//
// Uses the Bot API's getStarTransactions, which — contrary to the audit's
// open question in §22 — DOES expose native-affiliate metadata without any
// MTProto client: a `TransactionPartnerUser` transaction carries an
// `affiliate` field (`AffiliateInfo`: `commission_per_mille`, `amount`,
// `affiliate_user`/`affiliate_chat`) whenever that specific sale paid out a
// Telegram-native affiliate commission. This is the Bot API's equivalent of
// the MTProto-level `starref_peer` / `starref_amount` /
// `starref_commission_permille` fields the audit asked about.

const { db } = require('../firebaseAdmin');

const TG = 'https://api.telegram.org';

async function fetchStarTransactions(token, { offset = 0, limit = 100 } = {}) {
  const resp = await fetch(`${TG}/bot${token}/getStarTransactions?offset=${offset}&limit=${limit}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(`getStarTransactions failed: ${data.description || 'unknown error'}`);
  return data.result?.transactions || [];
}

function extractAffiliateInfo(transaction) {
  const affiliate = transaction.source?.affiliate;
  if (!affiliate) return null;
  return {
    commissionPerMille: affiliate.commission_per_mille,
    amount:              affiliate.amount,
    affiliateUserId:     affiliate.affiliate_user?.id ?? null,
    affiliateChatId:     affiliate.affiliate_chat?.id ?? null,
  };
}

// Paginates through every Stars transaction currently known to Telegram and
// diffs it against `payments` by telegram_payment_charge_id (transaction.id
// in the Bot API IS the charge id for incoming payments).
async function reconcileStarsTransactions(token, { maxPages = 20, pageSize = 100 } = {}) {
  const telegramById = new Map();
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchStarTransactions(token, { offset, limit: pageSize });
    if (batch.length === 0) break;
    for (const txn of batch) telegramById.set(txn.id, txn);
    offset += batch.length;
    if (batch.length < pageSize) break;
  }

  const paymentsSnap = await db.collection('payments').where('method', '==', 'stars').get();
  const dbByChargeId = new Map();
  paymentsSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.telegram_payment_charge_id) dbByChargeId.set(data.telegram_payment_charge_id, { id: d.id, ...data });
  });

  const telegramOnly = []; // Telegram has it, Enma's DB doesn't
  const dbOnly       = []; // Enma's DB has it, Telegram doesn't (or it's refunded there)
  const affiliateTransactions = [];

  for (const [chargeId, txn] of telegramById) {
    const dbPayment = dbByChargeId.get(chargeId);
    const affiliate = extractAffiliateInfo(txn);
    if (affiliate) affiliateTransactions.push({ chargeId, affiliate, dbPaymentExists: !!dbPayment });
    if (!dbPayment) telegramOnly.push({ chargeId, amount: txn.amount, date: txn.date, refund: !!txn.refund });
  }
  for (const [chargeId, payment] of dbByChargeId) {
    if (!telegramById.has(chargeId)) dbOnly.push({ chargeId, paymentDocId: payment.id, status: payment.status });
  }

  if (telegramOnly.length > 0 || dbOnly.length > 0) {
    console.warn('[stars] stars_reconciliation_mismatch', {
      telegramOnlyCount: telegramOnly.length,
      dbOnlyCount: dbOnly.length,
    });
  }

  return {
    telegramTransactionCount: telegramById.size,
    dbPaymentCount: dbByChargeId.size,
    telegramOnly,
    dbOnly,
    affiliateTransactions,
  };
}

module.exports = { fetchStarTransactions, extractAffiliateInfo, reconcileStarsTransactions };
