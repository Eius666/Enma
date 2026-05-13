import type { Currency } from '../types';

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

export const BASE_CURRENCY: Currency = 'USD';
export const DEFAULT_CURRENCY: Currency = 'RUB';
export const SUPPORTED_CURRENCIES: Currency[] = ['USD', 'EUR', 'BYN', 'CNY', 'RUB'];

// ---------------------------------------------------------------------------
// Exchange rates cache
// ---------------------------------------------------------------------------

export const RATES_STORAGE_KEY = 'enma.exchangeRates';
export const RATES_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Preferences storage keys
// ---------------------------------------------------------------------------

export const THEME_STORAGE_KEY = 'enma.theme';
export const LANGUAGE_STORAGE_KEY = 'enma.language';
export const CURRENCY_STORAGE_KEY = 'enma.currency';

// ---------------------------------------------------------------------------
// Per-user data storage keys (used as `enma.{uid}.{key}`)
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  tasks: 'tasks',
  notes: 'notes',
  noteProjects: 'notes.projects',
  categories: 'finance.categories',
  transactions: 'finance.transactions',
  habits: 'habits',
  reminders: 'reminders',
} as const;

export const PROFILE_STORAGE_PREFIX = 'profile';

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export const ENABLE_CLIENT_REMINDERS =
  process.env.REACT_APP_CLIENT_REMINDERS === 'true';

// ---------------------------------------------------------------------------
// UI — calendar tasks
// ---------------------------------------------------------------------------

export const TASK_COLOR_PALETTE: string[] = [
  '#7C5CFF',
  '#FF7EB6',
  '#6CFFB8',
  '#58A6FF',
  '#F7D060',
  '#FF9F40',
];

// ---------------------------------------------------------------------------
// Finance — default categories (localized)
// ---------------------------------------------------------------------------

export type DefaultCategory = {
  id: string;
  nameEn: string;
  nameRu: string;
  type: 'income' | 'expense';
};

export const FINANCE_CATEGORIES: DefaultCategory[] = [
  { id: 'cat-salary',    nameEn: 'Salary',     nameRu: 'Зарплата', type: 'income' },
  { id: 'cat-freelance', nameEn: 'Freelance',  nameRu: 'Фриланс',  type: 'income' },
  { id: 'cat-food',      nameEn: 'Food',       nameRu: 'Еда',      type: 'expense' },
  { id: 'cat-software',  nameEn: 'Software',   nameRu: 'Софт',     type: 'expense' },
];

// ---------------------------------------------------------------------------
// Notes — default projects (localized)
// ---------------------------------------------------------------------------

export type DefaultNoteProject = {
  id: string;
  nameEn: string;
  nameRu: string;
};

export const NOTE_PROJECTS_DEFAULT: DefaultNoteProject[] = [
  { id: 'project-default', nameEn: 'General', nameRu: 'Общее' },
];

// ---------------------------------------------------------------------------
// Habits — colors
// ---------------------------------------------------------------------------

export const HABIT_COLORS: string[] = [
  '#7C5CFF',
  '#FF7EB6',
  '#6CFFB8',
  '#58A6FF',
  '#F7D060',
  '#FF9F40',
  '#A78BFA',
  '#34D399',
];

// ---------------------------------------------------------------------------
// Workspace icons
// ---------------------------------------------------------------------------

export const WORKSPACE_ICONS: string[] = [
  '📋', '💰', '✅', '📝', '🏃', '🎯', '❤️', '🏠', '🎓', '🔧',
];
