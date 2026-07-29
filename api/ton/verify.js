const { admin, db } = require('../_lib/firebaseAdmin');

const TONCENTER_API = 'https://toncenter.com/api/v2';
const WALLET_ADDRESS = process.env.TON_PAYMENT_WALLET || 'UQAmqtbkNs6OYMhQl83f_iesYhBrJJTPa7-wuIZCLEbSDplH';
const TX_LIMIT = 20;
// Max seconds between payment creation and on-chain confirmation
const TIME_WINDOW_SEC = 900;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { paymentId } = req.query;
  if (!paymentId || typeof paymentId !== 'string') {
    return res.status(400).json({ error: 'paymentId required' });
  }

  // 1. Read payment from Firestore
  const paymentRef = db.collection('payments').doc(paymentId);
  let paymentSnap;
  try {
    paymentSnap = await paymentRef.get();
  } catch (e) {
    console.error('Firestore read error:', e);
    return res.status(500).json({ error: 'Firestore error' });
  }

  if (!paymentSnap.exists) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const payment = paymentSnap.data();

  if (payment.status === 'confirmed') {
    return res.status(200).json({ status: 'confirmed', alreadyConfirmed: true });
  }

  // 2. Fetch last N transactions from TonCenter
  const apiKey = process.env.TONCENTER_API_KEY;
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  const url = `${TONCENTER_API}/getTransactions?address=${encodeURIComponent(WALLET_ADDRESS)}&limit=${TX_LIMIT}`;

  let tonData;
  try {
    const tonRes = await fetch(url, { headers });
    if (!tonRes.ok) {
      return res.status(502).json({ error: 'TonCenter API error', httpStatus: tonRes.status });
    }
    tonData = await tonRes.json();
  } catch (e) {
    console.error('TonCenter fetch error:', e);
    return res.status(502).json({ error: 'TonCenter unreachable' });
  }

  if (!tonData.ok || !Array.isArray(tonData.result)) {
    return res.status(502).json({ error: 'TonCenter API invalid response' });
  }

  // 3. Match by amount + time window
  // payment.amountTon is stored as float (e.g. 2.0 TON)
  const expectedNanotons = Math.round((payment.amountTon || 0) * 1e9);
  // createdAt can be a Firestore Timestamp or a plain ISO string
  const createdAtSec = payment.createdAt?.seconds
    ?? Math.floor(new Date(payment.createdAt).getTime() / 1000);

  const match = tonData.result.find(tx => {
    const inMsg = tx.in_msg;
    if (!inMsg || !inMsg.value) return false;
    const value = parseInt(inMsg.value, 10);
    const utime = tx.utime; // unix seconds

    // Amount must be exact (allow 1% tolerance for rounding)
    const amountOk = expectedNanotons > 0
      && Math.abs(value - expectedNanotons) / expectedNanotons < 0.01;
    // Tx must arrive after payment was created and within the window
    const timeOk = utime >= createdAtSec && utime <= createdAtSec + TIME_WINDOW_SEC;

    return amountOk && timeOk;
  });

  if (!match) {
    return res.status(200).json({ status: 'pending', message: 'Transaction not found yet' });
  }

  // 4. Confirm payment + update subscription in a batch
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.update(paymentRef, {
    status: 'confirmed',
    confirmedAt: now,
    txHash: match.transaction_id?.hash ?? null,
    txLt: match.transaction_id?.lt ?? null,
  });

  const userId = payment.userId;

  // 4a. Process referral commission (non-fatal)
  try {
    const { processSubscriptionPayment } = require('../_lib/referral/earnings');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    await processSubscriptionPayment(userId, 10, paymentId, token);
  } catch (referralErr) {
    console.error('[ton/verify] referral processing error:', referralErr.message);
  }
  const plan = payment.plan || 'pro';
  const periodMonths = payment.periodMonths || 1;

  const subRef = db.collection('subscriptions').doc(userId);
  const subSnap = await subRef.get();

  let expiresAt = new Date();
  if (subSnap.exists) {
    const existing = subSnap.data().expiresAt?.toDate?.();
    if (existing && existing > expiresAt) {
      expiresAt = existing; // extend from current expiry
    }
  }
  expiresAt.setMonth(expiresAt.getMonth() + periodMonths);

  batch.set(subRef, {
    userId,
    plan,
    status: 'active',
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    lastPaymentId: paymentId,
    updatedAt: now,
  }, { merge: true });

  try {
    await batch.commit();
  } catch (e) {
    console.error('Firestore batch write error:', e);
    return res.status(500).json({ error: 'Failed to confirm payment' });
  }

  return res.status(200).json({ status: 'confirmed' });
};
