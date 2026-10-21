import { renderHook, act } from '@testing-library/react';
import { usePreferences } from '../usePreferences';
import type { TelegramWebApp } from '../../telegram';

const tg = (over: Record<string, unknown> = {}) => {
  const handlers: Record<string, () => void> = {};
  const app = {
    colorScheme: 'light',
    initDataUnsafe: { user: { language_code: 'ru' } },
    onEvent: (e: string, h: () => void) => { handlers[e] = h; },
    offEvent: (e: string) => { delete handlers[e]; },
    ...over,
  } as unknown as TelegramWebApp;
  return { app, handlers };
};

beforeEach(() => {
  localStorage.clear();
  document.body.className = '';
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true });
});

test('defaults: dark theme, English, RUB; body gets the theme class', () => {
  const { result } = renderHook(() => usePreferences(null));
  expect(result.current).toMatchObject({ theme: 'dark', language: 'en', currency: 'RUB' });
  expect(document.body.classList.contains('theme-dark')).toBe(true);
});

test('stored values win; invalid stored values are ignored', () => {
  localStorage.setItem('enma.theme', 'light');
  localStorage.setItem('enma.language', 'ru');
  localStorage.setItem('enma.currency', 'EUR');
  expect(renderHook(() => usePreferences(null)).result.current).toMatchObject({ theme: 'light', language: 'ru', currency: 'EUR' });

  localStorage.setItem('enma.theme', 'purple');
  localStorage.setItem('enma.language', 'de');
  localStorage.setItem('enma.currency', 'XXX');
  Object.defineProperty(window.navigator, 'language', { value: 'ru-RU', configurable: true });
  expect(renderHook(() => usePreferences(null)).result.current).toMatchObject({ theme: 'dark', language: 'ru', currency: 'RUB' });
});

test('a manual theme/language choice is persisted; nothing is persisted before one is made (except currency)', () => {
  const { result } = renderHook(() => usePreferences(null));
  expect(localStorage.getItem('enma.theme')).toBeNull();
  expect(localStorage.getItem('enma.language')).toBeNull();
  expect(localStorage.getItem('enma.currency')).toBe('RUB');
  act(() => result.current.toggleTheme());
  act(() => result.current.updateLanguage('ru'));
  expect(result.current.theme).toBe('light');
  expect(localStorage.getItem('enma.theme')).toBe('light');
  expect(localStorage.getItem('enma.language')).toBe('ru');
  expect(document.body.classList.contains('theme-light')).toBe(true);
});

test('without manual choices Telegram drives theme and language, and theme changes are followed', () => {
  const { app, handlers } = tg();
  const { result } = renderHook(() => usePreferences(app));
  expect(result.current.theme).toBe('light');
  expect(result.current.language).toBe('ru');
  (app as unknown as { colorScheme: string }).colorScheme = 'dark';
  act(() => handlers.themeChanged());
  expect(result.current.theme).toBe('dark');
});

test('manual choices are NOT overridden by Telegram', () => {
  localStorage.setItem('enma.theme', 'dark');
  localStorage.setItem('enma.language', 'en');
  const { app } = tg();
  const { result } = renderHook(() => usePreferences(app));
  expect(result.current.theme).toBe('dark');
  expect(result.current.language).toBe('en');
});

test('works when localStorage is unusable (no exception, defaults apply)', () => {
  const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  const setSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => usePreferences(null));
  expect(result.current).toMatchObject({ theme: 'dark', language: 'en', currency: 'RUB' });
  act(() => result.current.toggleTheme());
  expect(result.current.theme).toBe('light');
  spy.mockRestore(); setSpy.mockRestore();
});
