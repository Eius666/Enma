'use strict';

// Admin: notes forensics — read-only, single-uid diagnostic (ENMA notes-
// durability audit). Mirrors scripts/diagnoseNotes.js but runs where the
// Admin SDK credentials actually live (Vercel's own runtime env), so it
// can be called with just the already-provisioned ADMIN_API_KEY instead of
// needing FIREBASE_SERVICE_ACCOUNT pulled onto whatever machine is asking.
//
// Hard safety rules, not just conventions:
//   - `uid` is REQUIRED in the body; there is no "scan everyone" mode.
//   - A second, optional `compareUid` lets the caller check two SPECIFIC,
//     already-known uids against each other in one call (e.g. the known
//     test uid vs. whatever uid the caller found their current enma.su
//     session to be) — never used to go looking for other uids itself.
//   - The response never contains a note's title/content — only ids,
//     counts, and structural flags.
//   - Zero writes.
//
// POST /api/ai/adminNotesDiagnostic. Built by the api/ai router (see
// api/ai/[action].js).

function createNotesDiagnostic(ctx) {
  const { db, requireAdmin } = ctx;

  async function _notesDiagnosticForUid(uid) {
    // The plain, unordered query — every doc actually owned by this uid,
    // regardless of whether it would survive the real app's orderBy.
    const topLevel = await db.collection('notes').where('userId', '==', uid).get();

    // The EXACT query NotesList.tsx runs (src/components/NotesList.tsx:
    // where('userId','==',uid) + orderBy('updatedAt','desc')). Firestore's
    // orderBy silently excludes any document missing that field — this
    // directly tests that hypothesis rather than assuming it. Caught
    // separately: a missing composite index fails this specific query with
    // `failed-precondition` while the plain where-only query above still
    // works fine, which would otherwise look identical to "notes missing
    // updatedAt" from the count mismatch alone.
    let listQueryCount = null;
    let listQueryError = null;        // kept for backward compatibility with earlier diagnostic runs
    let listQueryErrorCode = null;
    let listQueryErrorMessage = null; // the FULL message — for FAILED_PRECONDITION on a missing index,
                                       // this is where Firestore puts the console link to create it
    try {
      const listQuerySnap = await db.collection('notes')
        .where('userId', '==', uid)
        .orderBy('updatedAt', 'desc')
        .get();
      listQueryCount = listQuerySnap.size;
    } catch (err) {
      listQueryError = err.code || err.message;
      listQueryErrorCode = err.code ?? null;
      listQueryErrorMessage = err.message ?? null;
    }

    const flagged = [];
    let archivedCount = 0, deletedCount = 0, missingUpdatedAtCount = 0, missingRevCount = 0;
    const byType = {}, byCategory = {};
    topLevel.forEach(docSnap => {
      const d = docSnap.data();
      const issues = [];
      if (d.deletedAt || d.isDeleted) { issues.push('marked_deleted'); deletedCount++; }
      if (d.archived) { issues.push('archived'); archivedCount++; }
      if (typeof d.title !== 'string') issues.push('title_missing_or_wrong_type');
      if (typeof d.content !== 'string' && d.type !== 'checklist') issues.push('content_missing_or_wrong_type');
      if (!d.updatedAt || typeof d.updatedAt.toDate !== 'function') { issues.push('updatedAt_missing_or_wrong_type'); missingUpdatedAtCount++; }
      if (typeof d.rev !== 'number') { issues.push('rev_missing_legacy'); missingRevCount++; }
      if (issues.length) flagged.push({ id: docSnap.id, issues });

      const typeKey = typeof d.type === 'string' ? d.type : '(missing)';
      byType[typeKey] = (byType[typeKey] || 0) + 1;
      const catKey = typeof d.category === 'string' ? d.category : '(missing)';
      byCategory[catKey] = (byCategory[catKey] || 0) + 1;
    });

    // Dead legacy subcollection path (users/{uid}/notes) from the old
    // workspace-subcollection rules/model — no live code writes or reads it.
    const legacySubcol = await db.collection('users').doc(uid).collection('notes').get();
    const legacyIds = legacySubcol.docs.map(d => d.id);
    const legacyMissingUserId = legacySubcol.docs.filter(d => !d.data().userId).length;

    const counterSnap = await db.collection('users').doc(uid).collection('freeUsage').doc('counters').get();
    const noteCount = counterSnap.exists ? (counterSnap.data().noteCount ?? null) : null;

    const telegramLinkSnap = await db.collection('telegramUsers').where('firebaseUid', '==', uid).limit(1).get();

    return {
      uid,
      topLevelNoteCount: topLevel.size,          // db.collection('notes').where('userId','==',uid) — no orderBy
      listQueryCount,                             // the SAME query PLUS .orderBy('updatedAt','desc') — what NotesList.tsx actually runs
      listQueryError,                             // deprecated alias of listQueryErrorCode — kept so an older stored diagnostic result stays readable
      listQueryErrorCode,                         // e.g. "failed-precondition" — a missing composite index, permission-denied, etc.
      listQueryErrorMessage,                      // the FULL error text — includes the Firebase console link to create a missing index
      listQueryExcludesDocs: listQueryError === null && listQueryCount !== null && listQueryCount !== topLevel.size,
      missingUpdatedAtCount,                      // of topLevel — these are exactly the docs orderBy would drop, if any
      missingRevCount,                            // legacy docs predating the rev field — expected to be harmless, not itself a problem
      archivedCount,
      deletedCount,
      byType,
      byCategory,
      flaggedNoteIds: flagged,
      legacySubcollectionNoteIds: legacyIds,      // users/{uid}/notes — dead path, no live code writes here
      legacySubcollectionMissingUserId: legacyMissingUserId,
      freeUsageNoteCounter: noteCount,
      freeUsageCounterMismatch: noteCount !== null && noteCount !== topLevel.size,
      linkedToTelegram: !telegramLinkSnap.empty,
    };
  }

  async function handleAdminNotesDiagnostic(req, res) {
    if (!requireAdmin(req, res)) return;

    const uid = req.body?.uid;
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ ok: false, error: 'uid_required' });
    }
    const compareUid = req.body?.compareUid;
    if (compareUid !== undefined && typeof compareUid !== 'string') {
      return res.status(400).json({ ok: false, error: 'compareUid_must_be_string' });
    }

    const primary = await _notesDiagnosticForUid(uid);
    let secondary = null;
    if (compareUid) {
      secondary = await _notesDiagnosticForUid(compareUid);
    }

    return res.status(200).json({
      ok: true,
      primary,
      compare: secondary ? { ...secondary, sameAccountAsPrimary: compareUid === uid } : null,
    });
  }

  return { handleAdminNotesDiagnostic };
}

module.exports = { createNotesDiagnostic };
