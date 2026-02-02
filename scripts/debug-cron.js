const { admin, db } = require('../api/_lib/firebaseAdmin');

const TELEGRAM_API = 'https://api.telegram.org';

// Helper for colored logs
const log = (...args) => console.log('\x1b[36m%s\x1b[0m', ...args);
const error = (...args) => console.error('\x1b[31m%s\x1b[0m', ...args);
const success = (...args) => console.log('\x1b[32m%s\x1b[0m', ...args);

async function checkTelegram(token) {
  if (!token) {
    error('❌ TELEGRAM_BOT_TOKEN is missing');
    return;
  }
  success('✅ TELEGRAM_BOT_TOKEN found');

  log('🔄 Verifying Bot Token...');
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      error(`❌ Telegram Bot Error: ${data.description}`);
    } else {
      success(`✅ Bot verified: @${data.result.username} (ID: ${data.result.id})`);
    }
  } catch (e) {
    error('❌ Failed to contact Telegram API:', e.message);
  }
}

async function checkFirestore() {
  log('🔄 Checking Firestore connection...');
  try {
    // Just try to list collections or get text connection
    const collections = await db.listCollections();
    success(`✅ Firestore connected. Found ${collections.length} collections.`);
    
    log('🔄 Checking "reminders" collection...');
    const now = admin.firestore.Timestamp.fromDate(new Date());
    const snapshot = await db.collection('reminders').limit(5).get();
    
    if (snapshot.empty) {
      log('⚠️ Collection "reminders" is empty or has no documents.');
    } else {
      success(`✅ Found ${snapshot.size} sample documents in 'reminders'.`);
      
      let pendingCount = 0;
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.status === 'pending') {
          pendingCount++;
          log(`   📝 Found PENDING reminder: ${doc.id}`);
          log(`      Scheduled: ${data.scheduledAt?.toDate?.()?.toISOString() ?? data.scheduledAt}`);
          log(`      Current Time: ${new Date().toISOString()}`);
        }
      });
      
      if (pendingCount === 0) {
        log('ℹ️ No PENDING reminders found in the sample (this might be why cron does nothing).');
      }
    }
  } catch (e) {
    error('❌ Firestore check failed:', e);
    if (e.message.includes('credential')) {
      error('   👉 Check your FIREBASE_SERVICE_ACCOUNT variable.');
    }
  }
}

async function main() {
  console.log('\n--- 🕵️‍♂️ Starting Cron Debugger ---\n');
  
  // 1. Check Env Vars
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    error('❌ FIREBASE_SERVICE_ACCOUNT is missing');
    error('   Please ensure you are running with .env variables loaded.');
  } else {
    success('✅ FIREBASE_SERVICE_ACCOUNT is present');
  }
  
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  // 2. Run Checks
  try {
    await checkTelegram(token);
    await checkFirestore();
  } catch (e) {
    error('❌ Unexpected script error:', e);
  }
  
  console.log('\n--- 🏁 Debugger Finished ---\n');
  process.exit(0);
}

main();
