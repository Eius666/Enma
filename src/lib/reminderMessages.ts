import { format, parseISO, setHours, setMinutes } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import type { Language, Reminder } from '../types/app';
import { translate } from '../i18n/appStrings';

// Pure helpers for reminder text and scheduling (moved out of App.tsx).

export const getDateLocale = (language: Language) => (language === 'ru' ? ru : enUS);

export const formatDate = (language: Language, date: Date, pattern: string) =>
  format(date, pattern, { locale: getDateLocale(language) });

export const buildTelegramReminderText = (reminder: Reminder, language: Language) => {
  const dateLabel = formatDate(language, parseISO(reminder.date), 'MMM d, yyyy');
  return `${translate(language, 'telegramReminderLine', {
    title: reminder.title,
    date: dateLabel,
    time: reminder.time
  })}${reminder.notes ? `\n${reminder.notes}` : ''}`;
};

export const getReminderScheduledDate = (reminder: Reminder) => {
  const baseDate = parseISO(reminder.date);
  const [hoursStr, minutesStr] = reminder.time.split(':');
  return setMinutes(setHours(baseDate, Number(hoursStr) || 0), Number(minutesStr) || 0);
};
