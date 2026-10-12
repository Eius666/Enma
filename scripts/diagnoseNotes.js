// Read-only, single-user notes diagnostic — ENMA notes-durability audit,
// PHASE 6.
//
// Scope and safety:
//   - Requires an explicit --uid; refuses to run without one (no scanning
//     "all users" by default).
//   - Only reads the `notes` collection (filtered to that uid) and the
//     dead/legacy `users/{uid}/notes` subcollection path that an older
//     rules version and workspace model used — nothing else.
//   - Never prints note title/content. Only IDs, counts, and flags.
//   - Makes zero writes.
//
// Requires Admin SDK credentials this environment is not given by default
// (see api/_lib/firebaseAdmin.js — FIREBASE_SERVICE_ACCOUNT). Run this
// LOCALLY, with your own credentials, not by pasting a key into chat:
//
//   FIREBASE_SERVICE_ACCOUNT='<your service account JSON>' \
//     node scripts/diagnoseNotes.js --uid=2MhVQ2hZD0cgDcYzxlHzhumml9l1
//
// or, if you're already logged in via `firebase login` with access to the
// project, Application Default Credentials also work:
//
//   gcloud auth application-default login
//   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/diagnoseNotes.js --uid=...

const uidArg = process.argv.find((a) => a.startsWith('--uid='));
if (!uidArg) {
  console.error('Usage: node scripts/diagnoseNotes.js --uid=<firebase-uid>');
  console.error('Refuses to run without a specific uid — this is a single-account diagnostic, not a scan.');
  process.exit(1);
}
const uid = uidArg.slice('--uid='.length).trim();
if (!uid) {
  console.error('Empty --uid value.');
  process.exit(1);
}

let admin, db;
try {
  ({ admin, db } = require('../api/_lib/firebaseAdmin'));
} catch (err) {
  console.error('Could not initialize Firebase Admin SDK:', err.message);
  console.error('Set FIREBASE_SERVICE_ACCOUNT (see api/_lib/firebaseAdmin.js) and re-run locally.');
  process.exit(1);
}

function tsInfo(v) {
  if (v == null) return 'missing';
  if (typeof v.toDate === 'function') return `Timestamp(${v.toDate().toISOString()})`;
  return `unexpected type: ${typeof v}`;
}

async function main() {
  console.log(`ENMA notes diagnostic — uid=${uid} — project=${admin.app().options.projectId || '(default)'}\n`);

  // ── Top-level /notes, filtered by userId == uid (the real, live path) ──
  const topLevel = await db.collection('notes').where('userId', '==', uid).get();
  console.log(`notes/{noteId} where userId == uid (no orderBy): ${topLevel.size} document(s)`);

  // The EXACT query NotesList.tsx runs: same where() PLUS
  // .orderBy('updatedAt','desc'). Firestore's orderBy silently excludes
  // any document missing that field — checked directly here (never
  // assumed) rather than inferred from the count alone, since a missing
  // composite index would fail this query outright with a DIFFERENT,
  // distinguishable error instead of just returning fewer docs.
  let listQueryCount = null, listQueryError = null;
  try {
    const listQuerySnap = await db.collection('notes')
      .where('userId', '==', uid)
      .orderBy('updatedAt', 'desc')
      .get();
    listQueryCount = listQuerySnap.size;
  } catch (err) {
    listQueryError = err.code || err.message;
  }
  if (listQueryError) {
    console.log(`notes/{noteId} where userId == uid ORDER BY updatedAt: QUERY FAILED — ${listQueryError}`);
    console.log('  (this is itself the bug if so — the real app would see the same failure)');
  } else {
    console.log(`notes/{noteId} where userId == uid ORDER BY updatedAt: ${listQueryCount} document(s)`);
    if (listQueryCount !== topLevel.size) {
      console.log(`  MISMATCH vs the no-orderBy count (${topLevel.size}) — ${topLevel.size - listQueryCount} document(s) are missing updatedAt and would be invisible in the real app.`);
    }
  }

  const flagged = [];
  let archivedCount = 0, deletedCount = 0, missingUpdatedAtCount = 0, missingRevCount = 0;
  const byType = {}, byCategory = {};
  topLevel.forEach((docSnap) => {
    const d = docSnap.data();
    const issues = [];
    if (d.deletedAt || d.isDeleted) { issues.push('marked deleted'); deletedCount++; }
    if (d.archived) { issues.push('archived'); archivedCount++; }
    if (typeof d.title !== 'string') issues.push('title: wrong/missing type');
    if (typeof d.content !== 'string' && d.type !== 'checklist') issues.push('content: wrong/missing type');
    if (d.updatedAt && typeof d.updatedAt.toDate !== 'function') { issues.push('updatedAt: not a Timestamp'); missingUpdatedAtCount++; }
    else if (!d.updatedAt) { issues.push('updatedAt: missing'); missingUpdatedAtCount++; }
    if (typeof d.rev !== 'number') { issues.push('rev: missing (legacy — treated as 0, not an error by itself)'); missingRevCount++; }
    if (issues.length) flagged.push({ id: docSnap.id, issues });

    const typeKey = typeof d.type === 'string' ? d.type : '(missing)';
    byType[typeKey] = (byType[typeKey] || 0) + 1;
    const catKey = typeof d.category === 'string' ? d.category : '(missing)';
    byCategory[catKey] = (byCategory[catKey] || 0) + 1;
  });

  console.log(`\narchived: ${archivedCount}  deleted-flagged: ${deletedCount}  missing updatedAt: ${missingUpdatedAtCount}  missing rev (legacy): ${missingRevCount}`);
  console.log(`by type:`, byType);
  console.log(`by category:`, byCategory);

  console.log(`\n  of which flagged for review: ${flagged.length}`);
  for (const f of flagged) {
    console.log(`   - ${f.id}: ${f.issues.join('; ')}`);
  }

  // ── Dead/legacy subcollection path: users/{uid}/notes/{noteId} ─────────
  // firestore.rules still has a rule block for this path (from an older
  // workspace-subcollection model) but no current code writes to it —
  // confirmed by reading src/components/NoteEditor.tsx/NotesList.tsx,
  // which both only ever touch the top-level notes/{noteId} collection.
  // Checked here anyway, read-only, in case something historical left
  // documents behind that the live app can no longer see.
  const legacySubcol = await db.collection('users').doc(uid).collection('notes').get();
  const legacyMissingUserId = legacySubcol.docs.filter((d) => !d.data().userId).length;
  console.log(`\nusers/${uid}/notes/{noteId} (legacy subcollection path): ${legacySubcol.size} document(s), ${legacyMissingUserId} missing userId`);
  legacySubcol.forEach((docSnap) => {
    console.log(`   - ${docSnap.id} (exists only here — the live UI never reads this path)`);
  });

  // ── Free-usage counter vs actual count. Historically this counter was
  //    incremented on every create and NEVER decremented on delete (see
  //    api/_lib/entities/createEntity.js) — a mismatch here, especially
  //    counter >= limit with topLevel.size far below it, is the exact
  //    "лимит достигнут, но заметок нет" signature, not just cosmetic
  //    confusion. ───────────────────────────────────────────────────────
  const counterSnap = await db.collection('users').doc(uid).collection('freeUsage').doc('counters').get();
  const counterVal = counterSnap.exists ? counterSnap.data().noteCount : null;
  console.log(`\nusers/${uid}/freeUsage/counters.noteCount: ${counterVal === null ? 'missing' : counterVal}`);
  if (counterVal !== null && counterVal !== topLevel.size) {
    console.log(`  MISMATCH vs actual note count (${topLevel.size}).`);
    if (counterVal >= 10) {
      console.log('  Counter is AT OR OVER the free-tier limit (10) while far fewer notes actually exist —');
      console.log('  this is the exact signature of the stale-counter bug (fixed server-side; redeploy required to take effect for this account).');
    }
  }

  console.log('\nDone. No writes were made. No note titles/content were printed above.');
}

main().catch((err) => {
  console.error('Diagnostic failed:', err.message);
  process.exit(1);
});
