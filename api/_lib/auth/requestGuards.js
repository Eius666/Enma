'use strict';

// Request guards shared by the api/ai/<action> handlers.
//
// - requireAuth: a Firebase ID token in `Authorization: Bearer …`; answers 401
//   and resolves to null when it is missing or invalid, else resolves to the
//   verified uid. Built from the Admin SDK instance the router was loaded with.
// - requireAdmin: the `x-admin-key` header must equal ADMIN_API_KEY; answers
//   403 and returns false otherwise (also when ADMIN_API_KEY is not set).

function createRequireAuth(admin) {
  return async function requireAuth(req, res) {
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
  };
}

function requireAdmin(req, res) {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.headers['x-admin-key'] !== key) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

module.exports = { createRequireAuth, requireAdmin };
