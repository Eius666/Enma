/**
 * Pure, Firestore-free scheduling logic for recurring habit reminders.
 *
 * Kept separate from index.ts (which does the Firestore/Telegram I/O) so the
 * timezone/day-of-week/idempotent-key math — the part most likely to hide a
 * subtle bug — can be unit tested deterministically, without mocking
 * firebase-admin or waiting on real time.
 */

// 0=Mon … 6=Sun — matches HabitDoc.repeatDays in src/components/HabitsList.tsx
// ("repeatDays?: number[]; // 0=Mon … 6=Sun") and the day-picker UI order in
// src/components/HabitEditor.tsx (t.days = ['Mon','Tue',...,'Sun']).
const WEEKDAY_SHORT_TO_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

export interface HabitScheduleInput {
  repeatType: 'daily' | 'custom';
  repeatDays?: number[];
  reminderTime?: string | null; // 'HH:MM'
  archived?: boolean;
}

/**
 * The full decision for "today" — always resolved, even when the habit
 * isn't due, so the caller can locate (and cancel, if still pending) a
 * stale occurrence a no-longer-due habit may already own for today.
 */
export interface HabitOccurrenceDecision {
  /** 'YYYY-MM-DD' in the user's timezone — the calendar day this occurrence belongs to. */
  dateKey: string;
  /** Stable, collision-free id: shared with the legacy client-side scheduler
   *  (src/App.tsx used to write this same scheme) so both paths can safely
   *  coexist without ever creating two reminders for the same habit/day. */
  docId: string;
  /** Whether a reminder should exist for this habit today. */
  due: boolean;
  /** Absolute instant (UTC) the reminder should be delivered at — set iff `due`. */
  scheduledAt: Date | null;
}

/** Returns 'YYYY-MM-DD' for `now` as displayed in `timezone`. */
export function getLocalDateKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Returns 0=Mon … 6=Sun for `now` as displayed in `timezone`. */
export function getLocalWeekdayIndex(now: Date, timezone: string): number {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short',
  }).format(now);
  const idx = WEEKDAY_SHORT_TO_INDEX[short];
  if (idx === undefined) {
    throw new Error(`Unrecognized weekday "${short}" for timezone "${timezone}"`);
  }
  return idx;
}

/**
 * Converts a local wall-clock time ('YYYY-MM-DD' + 'HH:MM') in `timezone`
 * into the absolute UTC instant it refers to — correctly across DST
 * transitions. Mirrors api/_lib/tools.js's localToUtc (kept as an
 * independent copy: functions/ is a separate deploy target with its own
 * node_modules and cannot import from api/_lib).
 */
export function localToUtc(dateStr: string, timeStr: string, timezone: string): Date {
  const [y, m, d]   = dateStr.split('-').map(Number);
  const [h, min]    = timeStr.split(':').map(Number);

  // Treat the desired local time as if it were UTC.
  const pseudo = new Date(Date.UTC(y, m - 1, d, h, min));

  // Find what the target timezone displays for this pseudo-UTC instant.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(pseudo);

  const p: Record<string, number> = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }

  const tzAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, (p.hour ?? 0) % 24, p.minute ?? 0);
  return new Date(pseudo.getTime() - (tzAsUtcMs - pseudo.getTime()));
}

/** Whether a recurring habit is due on the given local weekday. */
export function isHabitDueOnWeekday(habit: HabitScheduleInput, weekdayIndex: number): boolean {
  if (habit.repeatType === 'daily') return true;
  const days = habit.repeatDays ?? [];
  return days.includes(weekdayIndex);
}

export function habitReminderDocId(habitId: string, dateKey: string): string {
  return `habit-${habitId}-${dateKey}`;
}

/**
 * Resolves today's reminder decision for a habit in the user's timezone.
 *
 * Deliberately only ever resolves "today" — never backfills multiple past
 * days — so that a materializer outage of any length catches up with at
 * most one reminder per habit once it resumes, instead of flooding the user
 * with a backlog (see PHASE 8 of the ENMA habit-notification task spec).
 *
 * `due` is false whenever nothing should exist for today: archived,
 * disabled (no reminderTime), not scheduled for today's weekday — but also
 * when `habitCreatedAt` is given and is AFTER today's reminder time. That
 * last case matters because this function is also called for a habit that
 * already existed before today; without it, creating a brand-new habit (or
 * editing an existing one) in the afternoon with a morning reminder time
 * would immediately fire a surprise "overdue" notification instead of
 * waiting for the next day it's actually due. It does NOT suppress a
 * same-day edit of an already-existing habit's reminderTime to an
 * already-past time today — only a reminder time that predates the habit's
 * own creation — so a genuine scheduler outage still catches up correctly
 * (see computeHabitOccurrence's docstring history / PHASE 1 of the
 * pre-deploy review).
 */
export function resolveHabitOccurrence(
  habitId: string,
  habit: HabitScheduleInput,
  timezone: string,
  now: Date = new Date(),
  habitCreatedAt?: Date
): HabitOccurrenceDecision {
  const dateKey = getLocalDateKey(now, timezone);
  const docId   = habitReminderDocId(habitId, dateKey);
  const notDue  = (): HabitOccurrenceDecision => ({ dateKey, docId, due: false, scheduledAt: null });

  if (habit.archived) return notDue();
  if (!habit.reminderTime) return notDue();

  const weekdayIndex = getLocalWeekdayIndex(now, timezone);
  if (!isHabitDueOnWeekday(habit, weekdayIndex)) return notDue();

  const scheduledAt = localToUtc(dateKey, habit.reminderTime, timezone);
  if (habitCreatedAt && scheduledAt.getTime() < habitCreatedAt.getTime()) return notDue();

  return { dateKey, docId, due: true, scheduledAt };
}
