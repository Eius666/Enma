import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { User } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { saveProfile } from '../lib/profileStore';
import type { AppUserProfile } from '../types/app';
import type { TelegramWebApp } from '../telegram';

// Inside Telegram, a signed-in user without a display name gets the Telegram
// name (moved out of App.tsx unchanged).
export function useTelegramDisplayName(
  user: User | null,
  telegram: TelegramWebApp | null,
  profile: AppUserProfile | null,
  setProfile: Dispatch<SetStateAction<AppUserProfile | null>>
): void {
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user) return;
    if (profile?.displayName) return;
    const tgUser = telegram.initDataUnsafe.user;
    const tgName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Friend';
    const nextProfile: AppUserProfile = { displayName: tgName };
    setProfile(nextProfile);
    saveProfile(user.uid, nextProfile);
  }, [telegram, user, profile, setProfile]);
}

// Inside Telegram, records the Telegram profile of the signed-in user in
// telegramUsers/tg_<id> (moved out of App.tsx unchanged; what Firestore Rules
// accept for this document is decided there, not here).
export function useTelegramUserMapping(user: User | null, telegram: TelegramWebApp | null): void {
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
    const tgUser = telegram.initDataUnsafe.user;
    const docRef = doc(db, 'telegramUsers', `tg_${tgUser.id}`);
    setDoc(
      docRef,
      {
        chatId: tgUser.id,
        username: tgUser.username ?? null,
        firstName: tgUser.first_name ?? null,
        lastName: tgUser.last_name ?? null,
        languageCode: tgUser.language_code ?? null,
        firebaseUid: user.uid,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    ).catch(error => {
      console.warn('Failed to sync Telegram user', error);
    });
  }, [user, telegram]);
}
