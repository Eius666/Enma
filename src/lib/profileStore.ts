import type { AppUserProfile as UserProfile } from '../types/app';
import { PROFILE_STORAGE_PREFIX } from '../constants';
import { safeReadJson, safeWriteJson } from './safeStorage';

// Minimal per-user profile cached in localStorage (key format unchanged).
export const getProfileStorageKey = (uid: string) => `enma.${uid}.${PROFILE_STORAGE_PREFIX}`;

export const loadProfile = (uid: string): UserProfile | null =>
  safeReadJson<UserProfile | null>(getProfileStorageKey(uid), null);

export const saveProfile = (uid: string, data: UserProfile): void => {
  safeWriteJson(getProfileStorageKey(uid), data);
};
