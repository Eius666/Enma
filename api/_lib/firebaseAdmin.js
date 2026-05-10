const admin = require('firebase-admin');

const getServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
  if (raw.trim().startsWith('{')) return JSON.parse(raw);
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
};

let _admin = null;
let _db = null;
let _initError = null;

const init = () => {
  if (_admin) return;
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()) });
    }
    _admin = admin;
    _db = admin.firestore();
  } catch (err) {
    _initError = err;
  }
};

init();

const getAdmin = () => {
  if (_initError) throw _initError;
  return _admin;
};

const getDb = () => {
  if (_initError) throw _initError;
  return _db;
};

module.exports = {
  get admin() { return getAdmin(); },
  get db() { return getDb(); }
};
