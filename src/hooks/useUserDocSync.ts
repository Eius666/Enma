import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { User } from 'firebase/auth';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { CURRENCY_STORAGE_KEY, SUPPORTED_CURRENCIES } from '../constants';
import { safeSetItem } from '../lib/safeStorage';
import type { Currency } from '../types/app';
import type { TelegramWebApp } from '../telegram';
import { perfMark } from '../lib/perfMarks';

// Two effects that used to sit in App.tsx, unchanged:
//  1. link the Telegram chat id to users/{uid} (Firestore Rules only accept an
//     unchanged value for accounts that already have one);
//  2. a live listener on users/{uid} for the user's currency and bank list.
export function useUserDocSync(
  user: User | null,
  telegram: TelegramWebApp | null,
  setCurrency: Dispatch<SetStateAction<Currency>>,
  setBanks: Dispatch<SetStateAction<string[]>>
): void {
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    setDoc(doc(db, 'users', user.uid), {
      chatId,
      updatedAt: serverTimestamp()
    }, { merge: true }).catch(err => console.warn('Failed to sync user mapping', err));
  }, [user, telegram]);

  // Real-time, so a currency/bank change made elsewhere shows up at once.
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) return;
    const unsubscribe = onSnapshot(
      doc(db, 'users', uid),
      snap => {
        perfMark('first-snapshot:user-doc');
        const data = snap.data();
        if (data?.currency && SUPPORTED_CURRENCIES.includes(data.currency as Currency)) {
          const firestoreCurrency = data.currency as Currency;
          setCurrency(firestoreCurrency);
          safeSetItem(CURRENCY_STORAGE_KEY, firestoreCurrency);
        }
        if (data && Array.isArray(data.banks)) {
          setBanks(data.banks as string[]);
        }
        // Subscription is loaded exclusively from the subscriptions/{uid} listener.
      },
      err => console.warn('Failed to listen to user doc', err)
    );
    return unsubscribe;
    // Same trigger as before: only the uid; the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);
}
