import { format } from 'date-fns';
import { getDateLocale } from '../i18n/translations';
import type { Language, Currency, Category, NoteProject, UserProfile } from '../types';

export const createId = (): string => crypto.randomUUID();

export const formatDate = (language: Language, date: Date, pattern: string): string =>
  format(date, pattern, { locale: getDateLocale(language) });

export const taskColorPalette = ['#7C5CFF', '#FF7EB6', '#6CFFB8', '#58A6FF', '#F7D060', '#FF9F40'];

export const STORAGE_KEYS = {
  tasks: 'tasks',
  notes: 'notes',
  noteProjects: 'notes.projects',
  categories: 'finance.categories',
  transactions: 'finance.transactions',
  habits: 'habits',
  reminders: 'reminders'
};

export const THEME_STORAGE_KEY = 'enma.theme';
export const LANGUAGE_STORAGE_KEY = 'enma.language';
export const CURRENCY_STORAGE_KEY = 'enma.currency';

export const BASE_CURRENCY: Currency = 'USD';
export const SUPPORTED_CURRENCIES: Currency[] = ['USD', 'EUR', 'GBP', 'RUB'];

export const storageKey = (uid: string, key: string) => `enma.${uid}.${key}`;

const PROFILE_STORAGE_PREFIX = 'profile';
export const getProfileStorageKey = (uid: string) => `enma.${uid}.${PROFILE_STORAGE_PREFIX}`;

export const loadProfile = (uid: string): UserProfile | null => {
  try {
    const raw = localStorage.getItem(getProfileStorageKey(uid));
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
};

export const saveProfile = (uid: string, data: UserProfile) => {
  localStorage.setItem(getProfileStorageKey(uid), JSON.stringify(data));
};

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-salary', name: 'Salary', type: 'income' },
  { id: 'cat-freelance', name: 'Freelance', type: 'income' },
  { id: 'cat-food', name: 'Food', type: 'expense' },
  { id: 'cat-software', name: 'Software', type: 'expense' }
];

export const getDefaultCategories = (language: Language): Category[] => {
  if (language === 'ru') {
    return [
      { id: 'cat-salary', name: 'Зарплата', type: 'income' },
      { id: 'cat-freelance', name: 'Фриланс', type: 'income' },
      { id: 'cat-food', name: 'Еда', type: 'expense' },
      { id: 'cat-software', name: 'Софт', type: 'expense' }
    ];
  }
  return DEFAULT_CATEGORIES;
};

export const getDefaultNoteProjects = (language: Language): NoteProject[] => [
  { id: 'project-default', name: language === 'ru' ? 'Общее' : 'General' }
];
