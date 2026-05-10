import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from '../lib/firebase';
import type { TelegramWebApp } from '../telegram';

export const useAuth = (telegram: TelegramWebApp | null) => {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const anonAttemptedRef = useRef(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, current => {
      setUser(current);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (authLoading || user || anonAttemptedRef.current) return;
    if (!telegram?.initDataUnsafe?.user?.id) return;
    anonAttemptedRef.current = true;
    signInAnonymously(auth).catch(err => console.warn('Failed to sign in anonymously', err));
  }, [authLoading, user, telegram]);

  return { user, authLoading };
};
