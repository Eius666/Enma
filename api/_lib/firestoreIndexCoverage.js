'use strict';

// Pure, emulator-free check: does a given firestore.indexes.json actually
// contain a composite index that can serve a specific
// where(equality...) + orderBy(field) query?
//
// ENMA notes-durability audit — this is the exact class of bug that
// caused "лимит заметок достигнут, но все заметки исчезли": production
// had an index `notes: userId ASC, pinned DESC, updatedAt DESC` but NOT
// `notes: userId ASC, updatedAt DESC` — the extra `pinned` field sitting
// between the equality field and the orderBy field means that index
// cannot serve a plain where(userId)+orderBy(updatedAt) query at all
// (Firestore requires the orderBy field to immediately follow the
// equality-field prefix in the index, with no field — field it doesn't
// filter/order by — in between). A query shape ↔ indexes.json mismatch
// like this produces no compile-time or type error anywhere; it only
// surfaces as FAILED_PRECONDITION the first time the query actually
// runs. This check exists so that mismatch is caught in CI instead.
//
// Firestore's real matching rule (the part relevant to a single
// equality-set + single orderBy query, which is all NotesList.tsx uses):
//   - The index's fields, read as a prefix, must contain EXACTLY the
//     query's equality fields (as a set — order among themselves doesn't
//     matter) in the first N positions, where N = equality field count.
//   - The very next field (position N) must be the orderBy field, with
//     the same direction.
//   - Any fields after that are irrelevant (an index can be broader than
//     a query needs and still serve it).

/**
 * @param {{fieldPath: string, order: 'ASCENDING'|'DESCENDING'}[]} indexFields
 *   An index's `fields` array, as found in firestore.indexes.json
 *   (verbatim — any trailing `__name__` entry, which Firestore's own
 *   `firestore:indexes` output includes but firestore.indexes.json never
 *   does, is ignored if present).
 * @param {string[]} equalityFields - the query's where('field','==',...) fields.
 * @param {string} orderByField
 * @param {'ASCENDING'|'DESCENDING'} orderByDirection
 */
function indexServesQuery(indexFields, equalityFields, orderByField, orderByDirection) {
  const fields = indexFields.filter(f => f.fieldPath !== '__name__');
  const n = equalityFields.length;
  if (fields.length < n + 1) return false;

  const prefixNames = fields.slice(0, n).map(f => f.fieldPath);
  const prefixSet = new Set(prefixNames);
  if (prefixSet.size !== n) return false; // a duplicate field in the prefix can't match a set of N distinct equality fields
  for (const ef of equalityFields) {
    if (!prefixSet.has(ef)) return false;
  }

  const next = fields[n];
  if (!next) return false;
  return next.fieldPath === orderByField && next.order === orderByDirection;
}

/**
 * @param {{indexes: {collectionGroup: string, fields: {fieldPath:string, order:string}[]}[]}} indexesJson
 */
function collectionHasCoveringIndex(indexesJson, collectionGroup, equalityFields, orderByField, orderByDirection) {
  const candidates = (indexesJson.indexes || []).filter(i => i.collectionGroup === collectionGroup);
  return candidates.some(i => indexServesQuery(i.fields, equalityFields, orderByField, orderByDirection));
}

module.exports = { indexServesQuery, collectionHasCoveringIndex };
