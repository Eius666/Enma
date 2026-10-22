import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import type { Subscription } from '../subscription';
import { perfMark } from '../lib/perfMarks';

// Live `subscriptions/{uid}` document (written only by the server). Direct doc
// ref: no composite index, real-time (picks up a payment confirmation at once).
// The third value tells "no subscription" apart from "not loaded yet": it is
// true once the current user's document (or its absence) has been read.
export function useSubscription(user: User | null) {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setSubscription(null);
      return;
    }
    const unsubscribe = onSnapshot(
      doc(db, 'subscriptions', user.uid),
      snapshot => {
        perfMark('first-snapshot:subscription');
        if (snapshot.exists()) {
          setSubscription(snapshot.data() as Subscription);
        } else {
          setSubscription(null);
        }
        setLoadedFor(user.uid);
      },
      err => console.warn('Failed to load subscription', err)
    );
    return unsubscribe;
  }, [user]);

  const loaded = !!user && loadedFor === user.uid;
  return [subscription, setSubscription, loaded] as const;
}
