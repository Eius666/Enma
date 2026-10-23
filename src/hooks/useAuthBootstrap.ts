import { useCallback, useEffect, useRef, useState } from 'react';
import { User, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { auth } from '../firebase';
import { fetchWithTimeout } from '../lib/fetchWithTimeout';
import { decideBootstrap, AuthStatus } from '../lib/authBootstrap';
import { perfMark } from '../lib/perfMarks';
import type { TelegramWebApp } from '../telegram';

export type TelegramAuthErrorReason = 'generic' | 'identity_conflict' | 'recovery_required' | 'sdk_unavailable';

export interface AuthBootstrap {
  user: User | null;
  /** Firebase has not reported the persisted session (or its absence) yet. */
  authLoading: boolean;
  authStatus: AuthStatus;
  /** Only meaningful while authStatus === 'telegram_auth_error'. */
  telegramAuthErrorReason: TelegramAuthErrorReason;
  retryTelegramAuth: () => void;
  chooseOtherSignInMethod: () => void;
}

// Session restore + Telegram auto sign-in (moved out of App.tsx unchanged).
// `onNewTelegramUser` is called once the backend reports that the Telegram
// sign-in created a new account.
// `telegramSdk` (see useTelegramWebApp): inside Telegram, while the SDK is
// loading the Telegram-or-login decision waits; if it failed, the retry screen
// is shown (reason 'sdk_unavailable') and "retry" requests the SDK again.
export interface TelegramSdkState { pending: boolean; failed: boolean; retry: () => void }

export function useAuthBootstrap(
  telegram: TelegramWebApp | null,
  telegramSdk: TelegramSdkState,
  onNewTelegramUser: () => void
): AuthBootstrap {
  const { pending: telegramSdkPending, failed: telegramSdkFailed, retry: retryTelegramSdk } = telegramSdk;
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // See src/lib/authBootstrap.ts / TELEGRAM_AUTOLOGIN audit: kept separate
  // from `authLoading`/`user` specifically so the render layer can tell
  // "no session yet, but a Telegram auto-auth attempt is in flight" apart
  // from "no session and nothing else is going to happen" — the former
  // must never show the manual login screen.
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  // Only meaningful while authStatus === 'telegram_auth_error' — which of
  // the 3 distinct backend outcomes caused it, so the retry screen can show
  // honest, specific copy (see TELEGRAM_PASSWORDLESS_AUTOAUTH audit §12)
  // instead of one generic message for a network blip, an identity
  // conflict, and an orphaned historical mapping alike.
  const [telegramAuthErrorReason, setTelegramAuthErrorReason] = useState<TelegramAuthErrorReason>('generic');
  const telegramAuthAttemptedRef = useRef(false);
  const onNewTelegramUserRef = useRef(onNewTelegramUser);
  onNewTelegramUserRef.current = onNewTelegramUser;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, current => {
      perfMark('auth-resolved');
      setUser(current);
      setAuthLoading(false);
      if (current) setAuthStatus('authenticated');
    });
    return unsubscribe;
  }, []);

  // Telegram auto-auth bootstrap (TELEGRAM_PASSWORDLESS_AUTOAUTH audit).
  // Gates on raw `telegram.initData` ONLY — never `initDataUnsafe` —
  // because that's the one value the backend can actually HMAC-verify;
  // initDataUnsafe is diagnostics-only (see useTelegramWebApp's runtime
  // log) and must never decide whether we attempt or trust an auth flow.
  //
  // Deliberately does NOT fall back to signInAnonymously on failure
  // (removed — audit §1/§7): an anonymous Firebase user is a BRAND NEW,
  // disconnected identity, which is exactly the "duplicate account" outcome
  // this whole effort exists to prevent. If the verified-Telegram attempt
  // fails, the user sees a distinct retry screen (authStatus becomes
  // 'telegram_auth_error') — never a silently-empty new account, never the
  // manual AuthScreen automatically.
  const attemptTelegramAuth = useCallback(async (initData: string) => {
    perfMark('telegram-auth-start');
    setAuthStatus('telegram_auth');
    try {
      const res = await fetchWithTimeout('/api/auth/telegram', {
        timeoutMs: 30_000, // identity lookup is idempotent; a stalled request lands on the retry screen
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          await signInWithCustomToken(auth, data.token);
          perfMark('telegram-auth-done');
          if (data.isNewUser) onNewTelegramUserRef.current();
          return; // onAuthStateChanged fires next and sets 'authenticated'
        }
      }
      // TELEGRAM_IDENTITY_CONFLICT / TELEGRAM_ACCOUNT_RECOVERY_REQUIRED
      // (see api/auth/telegram.js) get their own copy — both are deliberate
      // "don't touch this account automatically" outcomes, not generic
      // failures, so they're distinguished here rather than lumped into the
      // same retry screen as a network error.
      let code: string | null = null;
      try { code = (await res.json())?.code ?? null; } catch { /* body already consumed or not JSON */ }
      setTelegramAuthErrorReason(
        code === 'TELEGRAM_IDENTITY_CONFLICT' ? 'identity_conflict' :
        code === 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED' ? 'recovery_required' :
        'generic'
      );
      throw new Error(`backend rejected (status ${res.status})`);
    } catch (err) {
      console.warn('Telegram auto-auth failed', err);
      perfMark('telegram-auth-failed');
      setAuthStatus('telegram_auth_error');
    }
  }, []);

  // decideBootstrap is a pure function (src/lib/authBootstrap.ts, unit
  // tested) specifically so the "don't show the login screen while Telegram
  // auth is still in flight" rule can't silently regress again — this is
  // the exact race this audit was opened for.
  useEffect(() => {
    if (authLoading) return;

    const decision = decideBootstrap({
      hasExistingSession: !!user,
      telegramInitDataPresent: !!telegram?.initData,
      alreadyAttemptedTelegramAuth: telegramAuthAttemptedRef.current,
      telegramSdkPending,
      telegramSdkFailed,
    });

    if (decision === 'wait') return;

    if (decision === 'telegram_sdk_error') {
      setTelegramAuthErrorReason('sdk_unavailable');
      setAuthStatus('telegram_auth_error');
      return;
    }

    if (decision === 'unauthenticated') {
      setAuthStatus('unauthenticated');
      return;
    }

    // decision === 'telegram_auth'
    telegramAuthAttemptedRef.current = true;
    attemptTelegramAuth(telegram!.initData);
  }, [authLoading, user, telegram, telegramSdkPending, telegramSdkFailed, attemptTelegramAuth]);

  // "Повторить вход через Telegram" — reuses the CURRENT raw initData
  // (audit §16), never asks for login/password/Telegram id.
  //
  // When the SDK itself is what failed, "retry" requests it again and shows
  // the loading screen; once it arrives the decision above runs the Telegram
  // sign-in (or, with no initData, shows the login screen as before).
  const retryTelegramAuth = useCallback(() => {
    if (telegramSdkFailed) {
      setAuthStatus('checking');
      retryTelegramSdk();
      return;
    }
    if (telegram?.initData) attemptTelegramAuth(telegram.initData);
  }, [telegram, telegramSdkFailed, retryTelegramSdk, attemptTelegramAuth]);

  // "Другой способ входа" — explicit opt-in escape hatch to the manual
  // AuthScreen. Only reachable from telegram_auth_error, never automatic.
  const chooseOtherSignInMethod = useCallback(() => {
    setAuthStatus('unauthenticated');
  }, []);

  return { user, authLoading, authStatus, telegramAuthErrorReason, retryTelegramAuth, chooseOtherSignInMethod };
}
