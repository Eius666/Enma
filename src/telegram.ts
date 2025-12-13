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
  ready: () => void;
  expand: () => void;
  onEvent?: (eventType: string, handler: (...args: any[]) => void) => void;
  offEvent?: (eventType: string, handler: (...args: any[]) => void) => void;
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
