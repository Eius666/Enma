import { format, isValid, parse, subDays } from 'date-fns';

export interface DateMatch {
  date: string;
  matchedText: string;
}

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function findDateInText(text: string, now: Date): DateMatch | null {
  const lower = text.toLowerCase();
  if (lower.includes('сегодня')) {
    return { date: formatDate(now), matchedText: 'сегодня' };
  }
  if (lower.includes('вчера')) {
    return { date: formatDate(subDays(now, 1)), matchedText: 'вчера' };
  }

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = parse(isoMatch[1], 'yyyy-MM-dd', now);
    if (isValid(parsed)) {
      return { date: formatDate(parsed), matchedText: isoMatch[1] };
    }
  }

  const dotMatch = text.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
  if (dotMatch) {
    const parsed = parse(dotMatch[1], 'dd.MM.yyyy', now);
    if (isValid(parsed)) {
      return { date: formatDate(parsed), matchedText: dotMatch[1] };
    }
  }

  return null;
}
