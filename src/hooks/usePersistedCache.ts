import { useEffect } from 'react';
import { safeWriteJson } from '../lib/safeStorage';

// Mirrors a piece of state into localStorage under `enma.<uid>.<key>` (same
// key/format as before) whenever it changes. localStorage is only a cache of
// what Firestore holds; failures are swallowed by safeWriteJson.
export function usePersistedCache(uid: string | undefined, key: string, value: unknown): void {
  useEffect(() => {
    if (!uid) return;
    safeWriteJson(`enma.${uid}.${key}`, value);
  }, [uid, key, value]);
}
