const { admin, db } = require('../api/_lib/firebaseAdmin');

async function debugFirestore() {
  console.log('🔍 Debugging Firestore Collections...');
  
  try {
    const collections = ['users', 'transactions', 'reminders'];
    
    for (const col of collections) {
      const snapshot = await db.collection(col).limit(5).get();
      console.log(`\nCollection: [${col}]`);
      if (snapshot.empty) {
        console.log('   - Empty');
      } else {
        console.log(`   - Found ${snapshot.size} documents (showing first 5)`);
        snapshot.forEach(doc => {
          console.log(`     ID: ${doc.id}`);
          console.log(`     Data: ${JSON.stringify(doc.data()).slice(0, 100)}...`);
        });
      }
    }
  } catch (error) {
    console.error('❌ Error debugging Firestore:', error);
  }
}

debugFirestore();
