const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const message = process.env.MESSAGE;

if (!serviceAccountPath || !telegramToken || !message) {
  console.error(
    'Missing env vars. Set FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN, MESSAGE.'
  );
  process.exit(1);
}

const serviceAccount = require(path.resolve(serviceAccountPath));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const run = async () => {
  const snapshot = await admin.firestore().collection('telegramUsers').get();
  const chatIds = snapshot.docs
    .map(doc => doc.data().chatId)
    .filter(Boolean);

  console.log(`Found ${chatIds.length} chat ids.`);

  let sent = 0;
  let failed = 0;
  for (const chatId of chatIds) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message })
        }
      );
      const payload = await response.json();
      if (response.ok && payload.ok) {
        sent += 1;
      } else {
        failed += 1;
        console.warn('Failed to send message', {
          chatId,
          status: response.status,
          description: payload?.description
        });
      }
    } catch (error) {
      failed += 1;
      console.warn('Failed to send message to chat', chatId, error);
    }
  }

  console.log(`Sent to ${sent}/${chatIds.length} users. Failed: ${failed}.`);
};

run().catch(error => {
  console.error('Broadcast failed', error);
  process.exit(1);
});
