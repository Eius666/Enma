const { admin, db } = require('../api/_lib/firebaseAdmin');

async function checkReminders() {
  console.log('🔍 Checking pending reminders...');
  
  try {
    const now = admin.firestore.Timestamp.now();
    console.log(`🕒 Server Time (UTC): ${new Date().toISOString()}`);
    console.log(`🕒 Firestore Timestamp: ${now.toDate().toISOString()}`);

    const snapshot = await db.collection('reminders')
      .orderBy('date', 'desc')
      .limit(10)
      .get();

    if (snapshot.empty) {
      console.log('✅ No reminders found at all.');
      return;
    }

    console.log(`\nFound ${snapshot.size} recent reminders:\n`);

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const scheduledAt = data.scheduledAt?.toDate();
      
      console.log(`ID: ${doc.id}`);
      console.log(`   Title: ${data.title}`);
      console.log(`   Status: ${data.status}`);
      console.log(`   Done: ${data.done}`);
      console.log(`   Scheduled At (UTC): ${scheduledAt?.toISOString()}`);
      if (data.lastError) console.log(`   ⚠️ Last Error: ${data.lastError}`);
      console.log('---------------------------------------------------');
    });

  } catch (error) {
    console.error('❌ Error checking reminders:', error);
  }
}

checkReminders();
