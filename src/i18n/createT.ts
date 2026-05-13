import { en } from './locales/en';
import { ru } from './locales/ru';
import type { Locale, TranslationKeys } from './index';

const locales: Record<Locale, TranslationKeys> = { en: en as TranslationKeys, ru };

export function createT(language: Locale) {
  return function t(path: string, params?: Record<string, string | number>): string {
    const keys = path.split('.');
    const resolve = (source: unknown): string | null => {
      let node = source;
      for (const k of keys) {
        if (node && typeof node === 'object' && k in (node as object)) {
          node = (node as Record<string, unknown>)[k];
        } else {
          return null;
        }
      }
      return typeof node === 'string' ? node : null;
    };

    const result = resolve(locales[language]) ?? resolve(locales.en) ?? path;
    if (!params) return result;
    return result.replace(/\{(\w+)\}/g, (_, token) =>
      String(params[token] !== undefined ? params[token] : `{${token}}`)
    );
  };
}
