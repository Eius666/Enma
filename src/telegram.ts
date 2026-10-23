export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramWebApp = {
  initData: string;
  initDataUnsafe: {
    user?: TelegramUser;
  };
  colorScheme: 'light' | 'dark' | 'unknown';
  viewportHeight?: number;
  safeAreaInset?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  contentSafeAreaInset?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  ready: () => void;
  expand: () => void;
  onEvent?: (eventType: string, handler: (...args: any[]) => void) => void;
  offEvent?: (eventType: string, handler: (...args: any[]) => void) => void;
  // Official Mini App Invoice API (Telegram Stars Audit §5) — the callback
  // reports ONLY the sheet's close reason (paid/cancelled/failed/pending),
  // never a reason to activate anything client-side. Entitlement comes
  // exclusively from the backend after successful_payment.
  openInvoice?: (url: string, callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void) => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
    /** Set by the SDK <script> tag in public/index.html when it finishes. */
    __enmaTgSdk?: 'loaded' | 'failed';
  }
}

export const getTelegramWebApp = (): TelegramWebApp | null =>
  window.Telegram?.WebApp ?? null;

// The Telegram SDK (public/index.html) loads without blocking the page, so the
// app can start before it has run. Whether this page is a Telegram Mini App is
// known without it: Telegram opens the page with its launch parameters in the
// URL hash (#tgWebAppData=…&tgWebAppVersion=…&tgWebAppPlatform=…), and the SDK
// keeps them in sessionStorage across a reload; Telegram's mobile apps also
// add their TelegramWebviewProxy bridge. Only the parameter NAMES are
// looked at — never the values: the signed initData still comes only from the
// SDK (WebApp.initData) and is still verified by the server.
const LAUNCH_PARAMS = ['tgWebAppData', 'tgWebAppVersion', 'tgWebAppPlatform'];

export function launchedFromTelegram(): boolean {
  // Telegram's mobile apps inject this bridge (an extra signal; the hash is the main one).
  if (typeof (window as unknown as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy !== 'undefined') return true;
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
    const names = query.split('&').map(p => decodeURIComponent(p.split('=')[0] || ''));
    if (names.some(n => LAUNCH_PARAMS.includes(n))) return true;
  } catch { /* malformed hash — try the stored copy */ }
  try {
    const stored = JSON.parse(window.sessionStorage.getItem('__telegram__initParams') || 'null');
    return !!stored && typeof stored === 'object' && LAUNCH_PARAMS.some(n => typeof stored[n] === 'string' && stored[n] !== '');
  } catch {
    return false;
  }
}

/** The SDK has run (WebApp present) or will not (its script failed). */
export function telegramSdkSettled(): boolean {
  return !!getTelegramWebApp() || window.__enmaTgSdk === 'loaded' || window.__enmaTgSdk === 'failed';
}

const SDK_SRC = 'https://telegram.org/js/telegram-web-app.js';

/** The most recently added SDK <script> (a retry adds a new one). */
function latestSdkScript(): HTMLScriptElement | null {
  const all = document.querySelectorAll<HTMLScriptElement>('script[src*="telegram-web-app.js"]');
  return all.length ? all[all.length - 1] : null;
}

/**
 * Resolves once the SDK script has loaded or failed — with WebApp, or null if
 * there is none. No time limit here: the caller decides how long to show the
 * loading screen (useTelegramWebApp) and keeps listening, so an SDK that
 * arrives late still lets the start continue.
 */
export function whenTelegramSdkSettled(): Promise<TelegramWebApp | null> {
  if (telegramSdkSettled()) return Promise.resolve(getTelegramWebApp());
  const script = latestSdkScript();
  if (!script) return Promise.resolve(getTelegramWebApp());
  return new Promise(resolve => {
    const done = () => {
      script.removeEventListener('load', done);
      script.removeEventListener('error', done);
      resolve(getTelegramWebApp());
    };
    script.addEventListener('load', done);
    script.addEventListener('error', done);
    // It may have settled between the check above and these listeners.
    if (telegramSdkSettled()) done();
  });
}

/** "Retry" after the SDK failed: request the same script once more. */
export function loadTelegramSdkAgain(): void {
  if (getTelegramWebApp()) return;
  window.__enmaTgSdk = undefined;
  const script = document.createElement('script');
  script.async = true;
  script.src = SDK_SRC;
  script.addEventListener('load', () => { window.__enmaTgSdk = 'loaded'; });
  script.addEventListener('error', () => { window.__enmaTgSdk = 'failed'; });
  document.head.appendChild(script);
}
