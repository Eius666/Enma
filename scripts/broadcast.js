// Usage:
//   FIREBASE_SERVICE_ACCOUNT=<base64-or-json> \
//   TELEGRAM_BOT_TOKEN=<token> \
//   MESSAGE="Your message" \
//   node scripts/broadcast.js [--dry-run]
//
// FIREBASE_SERVICE_ACCOUNT accepts either:
//   - Raw JSON:   {"type":"service_account",...}
//   - Base64 JSON: produced by `node scripts/encode-key.js`

if (parseInt(process.versions.node) < 18) {
  console.error('Node.js 18+ required. Current:', process.version);
  process.exit(1);
}

const admin = require('firebase-admin');

const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const message = process.env.MESSAGE;
const dryRun = process.argv.includes('--dry-run');

if (!serviceAccountRaw || !telegramToken || !message) {
  console.error('Required env vars: FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN, MESSAGE');
  process.exit(1);
}

const serviceAccount = (() => {
  const raw = serviceAccountRaw.trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
})();

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// 1 msg/sec per chat is Telegram's limit for bots
const sleep = ms => new Promise(r => setTimeout(r, ms));

const run = async () => {
  const snapshot = await admin.firestore().collection('telegramUsers').get();
  const chatIds = snapshot.docs.map(doc => doc.data().chatId).filter(Boolean);

  console.log(`Found ${chatIds.length} chat ID(s). Message: "${message}"${dryRun ? ' [DRY RUN]' : ''}`);

  let sent = 0;
  let failed = 0;
  for (const chatId of chatIds) {
    if (dryRun) {
      console.log(`  Would send to ${chatId}`);
      sent += 1;
      continue;
    }
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
        console.log(`  Sent to ${chatId}`);
      } else {
        failed += 1;
        console.warn(`  Failed ${chatId}: ${payload?.description}`);
      }
    } catch (error) {
      failed += 1;
      console.warn(`  Error ${chatId}:`, error.message);
    }
    await sleep(1100); // stay under 1 msg/sec per chat
  }

  console.log(`\nResult: ${sent} sent, ${failed} failed out of ${chatIds.length}.`);
};

run().catch(error => {
  console.error('Broadcast failed:', error);
  process.exit(1);
});
