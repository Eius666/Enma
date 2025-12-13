import { useEffect, useState } from 'react';
import { TelegramWebApp, getTelegramWebApp } from '../telegram';

export const useTelegramWebApp = (): TelegramWebApp | null => {
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(null);

  useEffect(() => {
    const tg = getTelegramWebApp();
    if (!tg) return;
    tg.ready();
    tg.expand();
    setWebApp(tg);
  }, []);

  return webApp;
};
