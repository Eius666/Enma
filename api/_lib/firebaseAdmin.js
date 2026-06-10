const admin = require('firebase-admin');

const getServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
  }

  if (raw.trim().startsWith('{')) {
    return JSON.parse(raw);
  }

  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(decoded);
};

const initAdmin = () => {
  if (admin.apps.length) return admin;
  const serviceAccount = getServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  return admin;
};

const firebaseAdmin = initAdmin();
const db = firebaseAdmin.firestore();

/**
 * Read the user's selected currency from their Firestore document.
 * Falls back to 'USD' (the base currency) if the document or field is missing.
 */
async function getUserCurrency(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return 'USD';
  const currency = userDoc.data().currency;
  const SUPPORTED = ['USD', 'EUR', 'BYN', 'CNY', 'RUB'];
  return SUPPORTED.includes(currency) ? currency : 'USD';
}

module.exports = { admin: firebaseAdmin, db, getUserCurrency };
