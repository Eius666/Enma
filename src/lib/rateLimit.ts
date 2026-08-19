import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../firebase';

export type RateLimitAction = 'ai_text' | 'ai_image' | 'ai_chat';

const WINDOW_MS: Record<RateLimitAction, number> = {
  ai_text:  10_000,
  ai_image: 30_000,
  ai_chat:  10_000,
};

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if the user is allowed to perform the action.
// Reads lastRequestAt from Firestore rateLimits/{userId}_{action}.
// ─────────────────────────────────────────────────────────────────────────────

export async function checkRateLimit(
  userId: string,
  action: RateLimitAction,
): Promise<RateLimitResult> {
  const docId = `${userId}_${action}`;
  const snap  = await getDoc(doc(db, 'rateLimits', docId));

  if (!snap.exists()) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const data      = snap.data();
  const lastAt    = (data?.lastRequestAt as Timestamp | undefined)?.toMillis() ?? 0;
  const windowMs  = WINDOW_MS[action];
  const elapsed   = Date.now() - lastAt;

  if (elapsed >= windowMs) {
    return { allowed: true, retryAfterMs: 0 };
  }

  return { allowed: false, retryAfterMs: windowMs - elapsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Record a request. Call AFTER the request is accepted (not before).
// ─────────────────────────────────────────────────────────────────────────────

export async function markRateLimitUsed(
  userId: string,
  action: RateLimitAction,
): Promise<void> {
  const docId = `${userId}_${action}`;
  await setDoc(doc(db, 'rateLimits', docId), {
    userId,
    action,
    lastRequestAt: serverTimestamp(),
  });
}
