// Local, per-device durability for notes being edited.
//
// Why this exists: src/firebase.ts initializes Firestore with a plain
// getFirestore(app) — no enableIndexedDbPersistence()/persistentLocalCache().
// That means this app's Firestore client has NO durable offline cache: a
// write attempted while offline just sits in the SDK's IN-MEMORY pending-
// mutation queue, and a page reload (or the app/WebView being killed) wipes
// that queue completely, along with whatever the user typed — which only
// ever lived in React state to begin with. Firestore's own automatic retry
// can only resume a write that is still in memory when connectivity
// returns; it cannot survive a reload on its own.
//
// This module is the actual safety net for that gap: every edit is mirrored
// into IndexedDB (uid+noteId scoped) the moment it happens in React state,
// independent of whether the Firestore write ever starts, succeeds, or is
// still hanging. It is deliberately NOT a replacement for Firestore and
// NOT a second source of truth — it is cleared the moment Firestore
// confirms the write, and on load it is only ever applied after comparing
// it against the server's revision (see decideDraftAction), never blindly.

export interface NoteDraftData {
  title: string;
  content: string;
  type: 'text' | 'checklist';
  checklistItems: { id: string; text: string; checked: boolean }[];
  category: string;
  pinned: boolean;
}

export interface NoteDraft extends NoteDraftData {
  uid: string;
  noteId: string;
  /** The server `rev` this draft's edits were made on top of. */
  baseRev: number;
  /** Date.now() of the last local persist — for display only, never used
   *  to decide ordering against the server (client clocks aren't trusted
   *  for that; baseRev is). */
  savedAtLocal: number;
}

export function draftKey(uid: string, noteId: string): string {
  return `${uid}::${noteId}`;
}

export type DraftDecision = 'restore' | 'conflict' | 'none';

/**
 * Pure decision, no storage access — whether a leftover local draft is safe
 * to silently apply over what was just loaded from Firestore.
 *
 * - draft.baseRev === serverRev: nothing else has written to this note
 *   since the draft was made — the draft is strictly the user's own
 *   unsynced edit. Safe to restore and resume syncing.
 * - draft.baseRev < serverRev: something else (another device/tab, or a
 *   session that successfully synced later) wrote a newer revision after
 *   this draft was taken. Restoring it would silently overwrite a newer
 *   version with an older one — surfaced as a conflict instead.
 * - draft.baseRev > serverRev: shouldn't happen (rev only moves forward),
 *   but on the off chance it does (e.g. a restore/rollback), fail toward
 *   not discarding local text outright rather than inventing a conflict
 *   over data we can't explain.
 */
export function decideDraftAction(draft: NoteDraft | null, serverRev: number): DraftDecision {
  if (!draft) return 'none';
  if (draft.baseRev === serverRev) return 'restore';
  if (draft.baseRev < serverRev) return 'conflict';
  return 'restore';
}

interface KVBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function createMemoryBackend(): KVBackend {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const DB_NAME = 'enma-note-drafts';
const STORE_NAME = 'drafts';

function createIndexedDBBackend(): KVBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  return {
    get(key) {
      return openDb().then(
        (db) =>
          new Promise<string | null>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
            req.onerror = () => reject(req.error);
          })
      );
    },
    set(key, value) {
      return openDb().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          })
      );
    },
    delete(key) {
      return openDb().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          })
      );
    },
  };
}

export class NoteDraftStore {
  private backend: KVBackend;

  constructor(backend?: KVBackend) {
    this.backend = backend ?? (typeof indexedDB !== 'undefined' ? createIndexedDBBackend() : createMemoryBackend());
  }

  // Every method is best-effort: browser storage can be blocked, full, or
  // cleared by the system or the user (private browsing, disabled site
  // data, manual "clear browsing data"). Losing this safety net must never
  // crash the editor or block the real Firestore write path — it only
  // reduces how much local protection is available, which is reported
  // honestly rather than assumed away.

  async save(draft: NoteDraft): Promise<void> {
    try {
      await this.backend.set(draftKey(draft.uid, draft.noteId), JSON.stringify(draft));
    } catch {
      /* best-effort only */
    }
  }

  async load(uid: string, noteId: string): Promise<NoteDraft | null> {
    try {
      const raw = await this.backend.get(draftKey(uid, noteId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as NoteDraft;
      // Defensive: never apply a draft that somehow doesn't match the
      // uid/noteId it was looked up for (e.g. a corrupted entry).
      if (parsed.uid !== uid || parsed.noteId !== noteId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async clear(uid: string, noteId: string): Promise<void> {
    try {
      await this.backend.delete(draftKey(uid, noteId));
    } catch {
      /* best-effort only */
    }
  }
}

let sharedStore: NoteDraftStore | null = null;

export function getNoteDraftStore(): NoteDraftStore {
  if (!sharedStore) sharedStore = new NoteDraftStore();
  return sharedStore;
}

/** Test-only: a fresh store over an in-memory backend, never touching the
 *  real IndexedDB or the module-level singleton. */
export function createInMemoryDraftStoreForTests(): NoteDraftStore {
  return new NoteDraftStore(createMemoryBackend());
}
