import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import type { Subscription } from '../subscription';

// Live `subscriptions/{uid}` document (written only by the server). Direct doc
// ref: no composite index, real-time (picks up a payment confirmation at once).
// Moved out of App.tsx unchanged.
export function useSubscription(user: User | null) {
  const [subscription, setSubscription] = useState<Subscription | null>(null);

  useEffect(() => {
    if (!user) {
      setSubscription(null);
      return;
    }
    const unsubscribe = onSnapshot(
      doc(db, 'subscriptions', user.uid),
      snapshot => {
        if (snapshot.exists()) {
          setSubscription(snapshot.data() as Subscription);
        } else {
          setSubscription(null);
        }
      },
      err => console.warn('Failed to load subscription', err)
    );
    return unsubscribe;
  }, [user]);

  return [subscription, setSubscription] as const;
}
