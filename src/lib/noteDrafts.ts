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
  /** All [key, value] pairs currently stored. Used only for listForUser —
   *  scanning the whole (small — one entry per actively-edited note) store
   *  is simpler and safer than maintaining a separate per-uid index. */
  entries(): Promise<Array<[string, string]>>;
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
    async entries() {
      return Array.from(map.entries());
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
    entries() {
      return openDb().then(
        (db) =>
          new Promise<Array<[string, string]>>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const keysReq = store.getAllKeys();
            const valuesReq = store.getAll();
            tx.oncomplete = () => {
              const keys = keysReq.result as string[];
              const values = valuesReq.result as string[];
              resolve(keys.map((k, i) => [k, values[i]]));
            };
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

  /**
   * Returns true only once the underlying storage transaction has actually
   * completed (not just been requested) — `set()` on both backends
   * resolves on commit (IndexedDB: `tx.oncomplete`), never on request
   * start. Returns false, rather than throwing, if local storage is
   * unavailable or the write failed (quota exceeded, blocked, private
   * mode) — callers treat this as "the local safety net is degraded right
   * now", never as a reason to fail the real Firestore write path.
   */
  async save(draft: NoteDraft): Promise<boolean> {
    try {
      await this.backend.set(draftKey(draft.uid, draft.noteId), JSON.stringify(draft));
      return true;
    } catch {
      return false;
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

  /**
   * All drafts left behind for this uid — including ones for a note that
   * never reached Firestore at all (a brand-new note whose first
   * entityCreate never completed has no server doc and no noteId anyone
   * else knows about; this is the only way to find it again). The caller
   * (NotesList) is responsible for cross-checking each noteId against the
   * user's actual Firestore notes to tell "never synced" apart from "still
   * being edited right now in another tab" — this method only reads local
   * storage, never Firestore.
   */
  async listForUser(uid: string): Promise<NoteDraft[]> {
    try {
      const prefix = `${uid}::`;
      const all = await this.backend.entries();
      const result: NoteDraft[] = [];
      for (const [key, raw] of all) {
        if (!key.startsWith(prefix)) continue;
        try {
          const parsed = JSON.parse(raw) as NoteDraft;
          if (parsed.uid === uid) result.push(parsed);
        } catch {
          /* skip a corrupted entry rather than fail the whole listing */
        }
      }
      return result;
    } catch {
      return [];
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

/**
 * Test-only: a store whose backend rejects on every operation — simulates
 * local storage being fully unavailable (quota exceeded, private browsing
 * blocking IndexedDB, "clear site data" mid-session, a disabled storage
 * permission). Every NoteDraftStore method must degrade to its safe
 * fallback (false/null/[]) rather than throwing.
 */
export function createFailingDraftStoreForTests(): NoteDraftStore {
  const failing: KVBackend = {
    get: () => Promise.reject(new Error('storage unavailable')),
    set: () => Promise.reject(new Error('storage unavailable')),
    delete: () => Promise.reject(new Error('storage unavailable')),
    entries: () => Promise.reject(new Error('storage unavailable')),
  };
  return new NoteDraftStore(failing);
}

/**
 * Test-only: a store that already has one genuinely corrupted entry (not
 * valid JSON, or valid JSON missing the shape a draft needs) sitting
 * alongside otherwise-normal data — simulates e.g. a half-written value
 * left behind by a previous crash. Bypasses NoteDraftStore.save() (which
 * only ever writes well-formed JSON) by writing the raw string directly
 * into the backend, the only way such an entry could realistically exist.
 */
export function createDraftStoreWithRawEntryForTests(key: string, rawValue: string): NoteDraftStore {
  const backend = createMemoryBackend();
  // Deliberately not awaited inside this sync factory — `set` on the
  // in-memory backend resolves synchronously under the hood, so the
  // entry is present before this function returns; callers that need a
  // stricter guarantee can `await` their own subsequent calls as usual.
  void backend.set(key, rawValue);
  return new NoteDraftStore(backend);
}

/**
 * Test-only: a backend that stores real data (so load/entries reflect
 * what was actually written) but whose `set` rejects every Nth call —
 * simulates an intermittently full/throttled store rather than a
 * completely dead one.
 */
export function createFlakyDraftStoreForTests(failEveryNthSet: number): NoteDraftStore {
  const inner = createMemoryBackend();
  let setCalls = 0;
  const flaky: KVBackend = {
    get: inner.get,
    delete: inner.delete,
    entries: inner.entries,
    set: (key, value) => {
      setCalls += 1;
      if (setCalls % failEveryNthSet === 0) {
        return Promise.reject(new Error('simulated quota exceeded'));
      }
      return inner.set(key, value);
    },
  };
  return new NoteDraftStore(flaky);
}
