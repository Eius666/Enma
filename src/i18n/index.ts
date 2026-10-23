import type { ru } from './locales/ru';

export type Locale = 'ru' | 'en';

type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};
export type TranslationKeys = DeepStringify<typeof ru>;
