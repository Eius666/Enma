'use strict';

const crypto = require('crypto');
const { admin, db } = require('../_lib/firebaseAdmin');

function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  return params;
}

async function resolveCanonicalUid(telegramId, chatId) {
  // 1. Check if canonical UID already assigned
  const canonicalRef = db.collection('canonicalUids').doc(`tg_${telegramId}`);
  const canonicalSnap = await canonicalRef.get();
  if (canonicalSnap.exists) {
    return canonicalSnap.data().uid;
  }

  // 2. Find all existing Firebase UIDs for this Telegram user
  const usersSnap = await db.collection('users')
    .where('chatId', '==', chatId)
    .get();

  let chosenUid = null;

  if (!usersSnap.empty) {
    // Prefer UID with active subscription; fallback to most recently updated
    let bestWithSub = null;
    let bestUpdatedAt = null;
    let bestNoSub = null;

    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
      const sub = data.subscription;
      const isPro = data.isPro === true;
      const isActive = isPro && sub?.status === 'active' && sub?.endDate && new Date(sub.endDate) > new Date();

      if (isActive) {
        if (!bestWithSub || updatedAt > bestUpdatedAt) {
          bestWithSub = userDoc.id;
          bestUpdatedAt = updatedAt;
        }
      } else {
        if (!bestNoSub || updatedAt > (bestNoSub.updatedAt ?? 0)) {
          bestNoSub = { uid: userDoc.id, updatedAt };
        }
      }
    }

    chosenUid = bestWithSub ?? bestNoSub?.uid ?? null;
  }

  // 3. Fall back to new deterministic UID
  if (!chosenUid) {
    chosenUid = `tg_${telegramId}`;
  }

  // 4. Persist canonical mapping
  await canonicalRef.set({ uid: chosenUid, telegramId, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });

  return chosenUid;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { initData } = req.body ?? {};
  if (!initData || typeof initData !== 'string') {
    return res.status(400).json({ error: 'Missing initData' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Server misconfigured' });

  const params = verifyInitData(initData, botToken);
  if (!params) return res.status(401).json({ error: 'Invalid initData signature' });

  let tgUser;
  try {
    tgUser = JSON.parse(params.get('user') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid user payload' });
  }

  const telegramId = tgUser.id;
  if (!telegramId) return res.status(400).json({ error: 'Missing user.id' });

  try {
    const uid = await resolveCanonicalUid(telegramId, telegramId);
    const token = await admin.auth().createCustomToken(uid);
    return res.status(200).json({ token, uid });
  } catch (err) {
    console.error('[auth/telegram] error', err);
    return res.status(500).json({ error: 'Auth failed' });
  }
};
