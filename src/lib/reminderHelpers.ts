import { parseISO, setHours, setMinutes } from 'date-fns';
import { translate } from '../i18n/translations';
import { formatDate } from './utils';
import type { Language, Reminder } from '../types';

export const ENABLE_CLIENT_REMINDERS = process.env.REACT_APP_CLIENT_REMINDERS === 'true';

export const getReminderScheduledDate = (reminder: Reminder): Date => {
  const baseDate = parseISO(reminder.date);
  const [hoursStr, minutesStr] = reminder.time.split(':');
  return setMinutes(setHours(baseDate, Number(hoursStr) || 0), Number(minutesStr) || 0);
};

export const buildTelegramReminderText = (reminder: Reminder, language: Language): string => {
  const dateLabel = formatDate(language, parseISO(reminder.date), 'MMM d, yyyy');
  return `${translate(language, 'telegramReminderLine', {
    title: reminder.title,
    date: dateLabel,
    time: reminder.time
  })}${reminder.notes ? `\n${reminder.notes}` : ''}`;
};

export const notifyTelegramReminder = async (
  chatId: number,
  reminder: Reminder,
  language: Language
): Promise<void> => {
  try {
    const text = buildTelegramReminderText(reminder, language);
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      console.warn('Telegram reminder failed', payload);
    }
  } catch (error) {
    console.warn('Failed to send Telegram reminder', error);
  }
};
