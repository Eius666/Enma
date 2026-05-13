import { en } from './locales/en';
import { ru } from './locales/ru';

export type Locale = 'ru' | 'en';

type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};
export type TranslationKeys = DeepStringify<typeof ru>;

const translations: Record<Locale, TranslationKeys> = { en: en as TranslationKeys, ru };

let currentLocale: Locale = 'ru';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate a dot-separated key with optional `{param}` interpolation.
 * Falls back to the English locale, then to the raw key string.
 *
 * @example t('auth.loading')
 * @example t('hero.greeting', { name: 'Alice' })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const keys = key.split('.');
  let result: unknown = translations[currentLocale];

  for (const k of keys) {
    if (result && typeof result === 'object' && k in (result as object)) {
      result = (result as Record<string, unknown>)[k];
    } else {
      // Try English fallback
      let fallback: unknown = translations.en;
      for (const fk of keys) {
        if (fallback && typeof fallback === 'object' && fk in (fallback as object)) {
          fallback = (fallback as Record<string, unknown>)[fk];
        } else {
          return key;
        }
      }
      result = fallback;
      break;
    }
  }

  if (typeof result !== 'string') return key;
  if (!params) return result;

  return result.replace(/\{(\w+)\}/g, (_, token) =>
    String(params[token] !== undefined ? params[token] : `{${token}}`)
  );
}

export { en, ru };
