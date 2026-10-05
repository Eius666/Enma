const admin = require('firebase-admin');

// A JSON.parse SyntaxError's own .message embeds a snippet of the string it
// failed on (confirmed the hard way — see TELEGRAM_PASSWORDLESS_AUTOAUTH
// incident report). Never let that propagate: catch here and throw a fixed,
// safe message instead, regardless of what the malformed value contained.
const getServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_CONFIG_MISSING');
  }

  try {
    if (raw.trim().startsWith('{')) {
      return JSON.parse(raw);
    }
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    throw new Error('FIREBASE_CONFIG_PARSE_FAILED');
  }
};

const initAdmin = () => {
  if (admin.apps.length) return admin;
  const serviceAccount = getServiceAccount();
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch {
    // Same reasoning as getServiceAccount: never let whatever the SDK's own
    // error message happens to contain (it shouldn't echo the key, but this
    // costs nothing to guard) propagate up.
    throw new Error('FIREBASE_INIT_FAILED');
  }
  return admin;
};

const firebaseAdmin = initAdmin();
const db = firebaseAdmin.firestore();

// Lazily returns the default Storage bucket.
// Throws a clear error if FIREBASE_STORAGE_BUCKET env var is absent.
function getBucket() {
  const name = process.env.FIREBASE_STORAGE_BUCKET;
  if (!name) throw new Error('FIREBASE_STORAGE_BUCKET is not configured');
  return firebaseAdmin.storage().bucket(name);
}

/**
 * Read the user's selected currency from their Firestore document.
 * Falls back to 'RUB' (the default base currency for ENMA) if the document or field is missing.
 */
async function getUserCurrency(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return 'RUB';
  const currency = userDoc.data().currency;
  const SUPPORTED = ['RUB', 'USD', 'EUR', 'BYN', 'CNY'];
  return SUPPORTED.includes(currency) ? currency : 'RUB';
}

async function getUserTimezone(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  const DEFAULT_TZ = 'Europe/Warsaw';
  if (!userDoc.exists) return DEFAULT_TZ;
  const tz = userDoc.data().timezone;
  return (typeof tz === 'string' && tz.length > 0) ? tz : DEFAULT_TZ;
}

module.exports = { admin: firebaseAdmin, db, getBucket, getUserCurrency, getUserTimezone };
