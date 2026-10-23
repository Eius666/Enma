import { useCallback, useEffect, useState } from 'react';
import {
  TelegramWebApp, getTelegramWebApp, launchedFromTelegram, loadTelegramSdkAgain, telegramSdkSettled, whenTelegramSdkSettled,
} from '../telegram';
import { perfMark } from '../lib/perfMarks';

/**
 * How long the loading screen waits for the Telegram SDK inside Telegram
 * before showing the error screen with a retry. Waiting goes on in the
 * background: an SDK that arrives later still continues the start.
 */
export const TELEGRAM_SDK_WAIT_MS = 10_000;

type SdkStatus = 'not-telegram' | 'loading' | 'ready' | 'failed';

export interface TelegramWebAppState {
  webApp: TelegramWebApp | null;
  /**
   * Opened inside Telegram, but the SDK (loaded without blocking the page) has
   * not run yet: initData is not known, so nothing may be decided from its
   * absence. Never true outside Telegram.
   */
  sdkPending: boolean;
  /** Inside Telegram the SDK failed to load or took longer than TELEGRAM_SDK_WAIT_MS. */
  sdkFailed: boolean;
  /** Request the SDK again (after sdkFailed). */
  retrySdk: () => void;
}

function initialStatus(): SdkStatus {
  if (getTelegramWebApp()) return 'ready';
  if (!launchedFromTelegram()) return 'not-telegram';
  return telegramSdkSettled() ? 'failed' : 'loading';
}

export const useTelegramWebApp = (): TelegramWebAppState => {
  // An SDK that already ran before React is used from the first render.
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(() => getTelegramWebApp());
  const [status, setStatus] = useState<SdkStatus>(initialStatus);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const inTelegram = launchedFromTelegram();
    const timer = inTelegram && !telegramSdkSettled()
      ? window.setTimeout(() => { if (active && !getTelegramWebApp()) setStatus('failed'); }, TELEGRAM_SDK_WAIT_MS)
      : undefined;
    void whenTelegramSdkSettled().then(tg => {
      if (!active) return;
      window.clearTimeout(timer);
      // Safe runtime diagnostic — presence/length only, NEVER the raw
      // initData string (it's HMAC-verified server-side, but it's still a
      // per-user payload and has no business in client logs). initDataUnsafe
      // is reported here for visibility only, same as it's used everywhere
      // else in this app — never as a trust source. See TELEGRAM_AUTOLOGIN audit.
      console.log('[telegram] runtime', {
        webAppPresent: !!tg,
        initDataPresent: !!tg?.initData,
        initDataLength: tg?.initData?.length ?? 0,
        initDataUnsafeUserPresent: !!tg?.initDataUnsafe?.user, // diagnostic only
      });
      if (tg) {
        setWebApp(tg);
        setStatus('ready');
      } else {
        setStatus(inTelegram ? 'failed' : 'not-telegram');
      }
    });
    return () => { active = false; window.clearTimeout(timer); };
  }, [attempt]);

  const retrySdk = useCallback(() => {
    const tg = getTelegramWebApp();
    if (tg) { setWebApp(tg); setStatus('ready'); return; }
    loadTelegramSdkAgain();
    setStatus('loading');
    setAttempt(a => a + 1);
  }, []);

  useEffect(() => {
    const tg = webApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    perfMark('telegram-sdk-ready');

    const updateViewportVars = () => {
      const height = tg.viewportHeight ?? window.innerHeight;
      document.documentElement.style.setProperty('--tg-viewport-height', `${height}px`);

      const safeArea = tg.contentSafeAreaInset ?? tg.safeAreaInset ?? {};
      const toPx = (value?: number) => (typeof value === 'number' ? `${value}px` : '');
      if (safeArea.top !== undefined) {
        document.documentElement.style.setProperty('--tg-safe-area-top', toPx(safeArea.top));
      }
      if (safeArea.bottom !== undefined) {
        document.documentElement.style.setProperty('--tg-safe-area-bottom', toPx(safeArea.bottom));
      }
      if (safeArea.left !== undefined) {
        document.documentElement.style.setProperty('--tg-safe-area-left', toPx(safeArea.left));
      }
      if (safeArea.right !== undefined) {
        document.documentElement.style.setProperty('--tg-safe-area-right', toPx(safeArea.right));
      }
    };

    updateViewportVars();
    tg.onEvent?.('viewportChanged', updateViewportVars);
    window.addEventListener('resize', updateViewportVars);

    return () => {
      tg.offEvent?.('viewportChanged', updateViewportVars);
      window.removeEventListener('resize', updateViewportVars);
    };
  }, [webApp]);

  return { webApp, sdkPending: status === 'loading', sdkFailed: status === 'failed', retrySdk };
};
