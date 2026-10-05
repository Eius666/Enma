// ── Auth bootstrap decision logic ────────────────────────────────────────────
//
// Pulled out of App.tsx as a pure function so the exact race condition this
// was built to fix (TELEGRAM_AUTOLOGIN audit) can be covered with a plain
// node:test unit test (src/lib/__tests__/authBootstrap.test.js) instead of
// needing a full React + Firebase + Telegram WebApp mount harness.
//
// The bug this guards against: Firebase's onAuthStateChanged resolves with
// `user = null` almost immediately for a clean browser/session (nothing to
// restore), which used to make App.tsx render the manual email/password
// AuthScreen right away — BEFORE the separate, asynchronous Telegram
// auto-auth attempt (fetch /api/auth/telegram → verify initData → sign in)
// had a chance to run or finish. `authStatus` adds a distinct
// 'telegram_auth' state so the render layer can keep showing a loading
// screen (never AuthScreen) while that attempt is in flight.
export type AuthStatus = 'checking' | 'telegram_auth' | 'authenticated' | 'unauthenticated';

// Called once Firebase's own session restore has resolved to "no user" and
// at most one Telegram-auth attempt has happened. Decides what to do next.
// Never looks at initDataUnsafe — only whether raw initData is a non-empty
// string, which is the one reliable, HMAC-verifiable signal that we are
// actually running inside Telegram (see telegram.ts / useTelegramWebApp).
export function decideBootstrap(params: {
  hasExistingSession: boolean;
  telegramInitDataPresent: boolean;
  alreadyAttemptedTelegramAuth: boolean;
}): 'telegram_auth' | 'unauthenticated' | 'wait' {
  if (params.hasExistingSession) return 'wait';
  if (params.alreadyAttemptedTelegramAuth) return 'wait';
  if (params.telegramInitDataPresent) return 'telegram_auth';
  return 'unauthenticated';
}
