import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { ChangesSnapshot } from '../lib/snapshotReducers';

// Live listener on `<collectionName> where userId == uid`, folded into React
// state by `reduce`. This is the lifecycle that used to be copy-pasted four
// times in App.tsx (transactions, habits, day tasks, reminders), unchanged:
//   - nothing happens without a uid;
//   - the subscription starts after a short delay (kept from the original —
//     it guards against Firestore listen/unlisten races on quick re-mounts);
//   - single-field filter only, so no composite index is required;
//   - cleanup cancels a not-yet-started subscription, ignores late callbacks
//     and unsubscribes;
//   - errors are logged, never thrown.
const START_DELAY_MS = 100;

export type ListenerLabels = { snapshotError: string; subscribeError: string };

export function useCollectionListener<T>(
  uid: string | null | undefined,
  collectionName: string,
  setState: Dispatch<SetStateAction<T[]>>,
  reduce: (prev: T[], snapshot: ChangesSnapshot, isFirst: boolean) => T[],
  labels: ListenerLabels
): void {
  useEffect(() => {
    if (!uid) return;

    let mounted = true;
    let unsubscribe: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (!mounted) return;
      const q = query(collection(db, collectionName), where('userId', '==', uid));
      let receivedFirstSnapshot = false;
      try {
        unsubscribe = onSnapshot(
          q,
          snapshot => {
            if (!mounted) return;
            const isFirst = !receivedFirstSnapshot;
            receivedFirstSnapshot = true;
            setState(prev => reduce(prev, snapshot as unknown as ChangesSnapshot, isFirst));
          },
          error => {
            if (!mounted) return;
            console.warn(labels.snapshotError, error);
          }
        );
      } catch (error) {
        console.warn(labels.subscribeError, error);
      }
    }, START_DELAY_MS);

    return () => {
      mounted = false;
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
    };
    // `reduce`, `setState` and `labels` are module-level / stable at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, collectionName]);
}
