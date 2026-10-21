// Defensive wrappers around window.localStorage.
//
// localStorage can throw in real life: QuotaExceededError when the quota is
// full, SecurityError when storage is disabled or blocked (some WebViews,
// private modes, strict privacy settings), and even merely *reading* the
// `localStorage` property can throw. Stored JSON can also be corrupted. None
// of that may crash the UI, and none of it may delete user data.
//
// Contract:
//   - nothing in this module throws;
//   - keys and value formats are exactly what callers pass (no prefixing,
//     no re-encoding), so existing stored data stays readable;
//   - failures never remove or overwrite anything on their own;
//   - diagnostics contain only the operation and the error *name* — never a
//     key (keys embed the user id), a value or an error message — and each
//     distinct failure is reported once per page session.

type Operation = 'unavailable' | 'read' | 'write' | 'remove' | 'parse' | 'serialize';

const reported = new Set<string>();

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) return name;
  }
  return 'UnknownError';
}

function report(operation: Operation, error: unknown): void {
  const name = errorName(error);
  const tag = `${operation}:${name}`;
  if (reported.has(tag)) return;
  reported.add(tag);
  try {
    console.warn(`[safeStorage] ${operation} failed (${name})`);
  } catch {
    /* console unavailable */
  }
}

function getStore(): Storage | null {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    return store ?? null;
  } catch (error) {
    report('unavailable', error);
    return null;
  }
}

/** Returns the stored string, or null if missing or storage is unusable. */
export function safeGetItem(key: string): string | null {
  const store = getStore();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch (error) {
    report('read', error);
    return null;
  }
}

/** Returns true if the value was stored. Never throws. */
export function safeSetItem(key: string, value: string): boolean {
  const store = getStore();
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch (error) {
    report('write', error); // includes QuotaExceededError
    return false;
  }
}

/** Removes ONE key (never clears storage). Returns true on success. */
export function safeRemoveItem(key: string): boolean {
  const store = getStore();
  if (!store) return false;
  try {
    store.removeItem(key);
    return true;
  } catch (error) {
    report('remove', error);
    return false;
  }
}

/**
 * Reads and parses JSON. Missing key, unusable storage or corrupted JSON all
 * yield `fallback`; corrupted data is left in place (not deleted).
 */
export function safeReadJson<T>(key: string, fallback: T): T {
  const raw = safeGetItem(key);
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    report('parse', error);
    return fallback;
  }
}

/** JSON.stringify + store (same format as before). Returns true if stored. */
export function safeWriteJson(key: string, value: unknown): boolean {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    report('serialize', error); // circular structure, BigInt, throwing toJSON
    return false;
  }
  if (typeof serialized !== 'string') {
    report('serialize', { name: 'NotSerializable' });
    return false;
  }
  return safeSetItem(key, serialized);
}

/** Test helper: forget which failures were already reported. */
export function __resetSafeStorageReportsForTests(): void {
  reported.clear();
}
