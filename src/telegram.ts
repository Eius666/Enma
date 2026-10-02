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
  }
}

export const getTelegramWebApp = (): TelegramWebApp | null =>
  window.Telegram?.WebApp ?? null;
