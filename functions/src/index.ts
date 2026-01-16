import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

admin.initializeApp();

const getTelegramToken = () => {
  const token = functions.config().telegram?.token;
  if (!token) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Missing telegram token. Set functions config telegram.token.'
    );
  }
  return token as string;
};

export const broadcastUpdate = functions.https.onCall(async (data, context) => {
  if (!context.auth?.token?.admin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
  }

  const message = String(data?.message ?? '').trim();
  if (!message) {
    throw new functions.https.HttpsError('invalid-argument', 'Message is required.');
  }

  const token = getTelegramToken();
  const snapshot = await admin.firestore().collection('telegramUsers').get();
  const chatIds = snapshot.docs
    .map(doc => doc.data().chatId as number | undefined)
    .filter(Boolean);

  let sent = 0;
  for (const chatId of chatIds) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
      const payload = (await response.json()) as { ok?: boolean };
      if (response.ok && payload.ok) {
        sent += 1;
      }
    } catch (error) {
      console.warn('Failed to send telegram message', error);
    }
  }

  await admin.firestore().collection('broadcasts').add({
    message,
    sentCount: sent,
    totalCount: chatIds.length,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { count: sent, total: chatIds.length };
});
