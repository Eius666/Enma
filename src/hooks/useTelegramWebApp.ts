import { useEffect, useState } from 'react';
import { TelegramWebApp, getTelegramWebApp } from '../telegram';

export const useTelegramWebApp = (): TelegramWebApp | null => {
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(null);

  useEffect(() => {
    const tg = getTelegramWebApp();
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
    if (!tg) return;
    tg.ready();
    tg.expand();
    setWebApp(tg);

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
  }, []);

  return webApp;
};
