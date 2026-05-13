import { format, parseISO, setHours, setMinutes, formatRelative } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import type { Locale } from '../i18n';

export type DateLanguage = Locale;

export function getDateLocale(language: DateLanguage) {
  return language === 'ru' ? ru : enUS;
}

/** Format a Date object with a date-fns pattern, respecting locale. */
export function formatDate(language: DateLanguage, date: Date, pattern: string): string {
  return format(date, pattern, { locale: getDateLocale(language) });
}

/** Format a Unix-millisecond timestamp with a date-fns pattern. */
export function formatTimestamp(
  language: DateLanguage,
  ts: number,
  pattern: string = 'MMM d, yyyy'
): string {
  return format(new Date(ts), pattern, { locale: getDateLocale(language) });
}

/** Format an ISO date string (YYYY-MM-DD or full ISO) with a pattern. */
export function formatISODate(
  language: DateLanguage,
  iso: string,
  pattern: string = 'MMM d, yyyy'
): string {
  return format(parseISO(iso), pattern, { locale: getDateLocale(language) });
}

/** Format a Date relative to now (e.g. "yesterday", "tomorrow"). */
export function formatRelativeDate(language: DateLanguage, date: Date): string {
  return formatRelative(date, new Date(), { locale: getDateLocale(language) });
}

/** Build a Date from a date string + HH:MM time string. */
export function buildScheduledDate(dateISO: string, time: string): Date {
  const base = parseISO(dateISO);
  const [hoursStr, minutesStr] = time.split(':');
  return setMinutes(setHours(base, Number(hoursStr) || 0), Number(minutesStr) || 0);
}

const MONTH_NAMES_EN = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_NAMES_RU = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];

/** Return the full month name for a 0-based month index. */
export function getMonthName(month: number, language: DateLanguage = 'en'): string {
  return language === 'ru' ? MONTH_NAMES_RU[month] : MONTH_NAMES_EN[month];
}
