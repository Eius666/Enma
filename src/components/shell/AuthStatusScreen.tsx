import React from 'react';
import type { AuthStatus } from '../../lib/authBootstrap';
import type { TelegramAuthErrorReason } from '../../hooks/useAuthBootstrap';
import type { TranslationKey } from '../../i18n/appStrings';

interface Props {
  theme: string;
  authLoading: boolean;
  authStatus: AuthStatus;
  telegramAuthErrorReason: TelegramAuthErrorReason;
  onRetryTelegram: () => void;
  onOtherSignInMethod: () => void;
  t: (key: TranslationKey) => string;
}

// The screens shown before the app shell while the session is being decided.
// Renders nothing once there is a decision the caller handles itself (a user,
// or the manual sign-in screen).
export function AuthStatusScreen({
  theme, authLoading, authStatus, telegramAuthErrorReason, onRetryTelegram, onOtherSignInMethod, t,
}: Props): React.ReactElement | null {
  // 'checking' (Firebase restoring any persisted session) AND 'telegram_auth'
  // (a Telegram auto-auth attempt is in flight) both keep showing this
  // loading screen — never AuthScreen. This is the exact fix for
  // TELEGRAM_PASSWORDLESS_AUTOAUTH: a fresh Telegram session used to fall
  // through to the manual login screen the instant Firebase reported "no
  // session", even though the Telegram sign-in attempt had not even
  // started yet.
  if (authLoading || authStatus === 'checking' || authStatus === 'telegram_auth') {
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <span className="auth-loading">
            {authStatus === 'telegram_auth' ? t('authLoadingTelegram') : t('authLoading')}
          </span>
        </div>
      </div>
    );
  }

  // Telegram initData was present but the auto-auth attempt itself failed
  // (network error, backend rejection, etc.) — a distinct screen, never a
  // silent fall-through to the manual login form (audit §15/§16). The same
  // screen when, inside Telegram, the Telegram SDK could not be loaded
  // ('sdk_unavailable'): retry requests it again.
  //
  // recovery_required gets its own, single-button copy: retrying the exact
  // same initData against a deterministically dead mapping changes nothing,
  // and "Создать новый аккаунт" must never be the primary (or only) action
  // here — audit §12. "Восстановить аккаунт" leads to the manual AuthScreen
  // as the only credential-based path available today; a dedicated
  // ownership-confirmation recovery flow (audit §13) is intentionally out
  // of scope for this round.
  if (authStatus === 'telegram_auth_error') {
    if (telegramAuthErrorReason === 'recovery_required') {
      return (
        <div className={`auth-screen theme-${theme}`}>
          <div className="auth-card loading-card">
            <p className="auth-error">{t('authTelegramRecoveryTitle')}</p>
            <button type="button" className="primary-button auth-submit" onClick={onOtherSignInMethod}>
              {t('authTelegramRecoveryAction')}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <p className="auth-error">
            {telegramAuthErrorReason === 'identity_conflict' ? t('authTelegramConflictTitle')
              : telegramAuthErrorReason === 'sdk_unavailable' ? t('authTelegramSdkErrorTitle')
              : t('authTelegramErrorTitle')}
          </p>
          <button type="button" className="primary-button auth-submit" onClick={onRetryTelegram}>
            {t('authTelegramErrorRetry')}
          </button>
          <button type="button" className="ghost-button" onClick={onOtherSignInMethod}>
            {t('authTelegramErrorOther')}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
