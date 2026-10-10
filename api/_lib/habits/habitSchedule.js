'use strict';

// Pure "is this habit still due today?" check, shared by the two independent
// schedulers that both deliver from the `reminders` collection in production:
//   - api/telegram/cron.js      (GitHub Actions, every 5 min — see
//     .github/workflows/telegram-cron.yml)
//   - functions/src/index.ts's sendDueReminders (Firebase, every 1 min)
//
// This is a deliberate, independent CommonJS port of
// functions/src/habitSchedule.ts's isHabitDueOnWeekday/getLocalWeekdayIndex —
// NOT a shared import: api/ and functions/ are separate Vercel/Firebase
// deploy targets with their own node_modules, so the same small amount of
// logic has to live in both places. Keep any fix to the due-ness rule in
// sync between the two.

const WEEKDAY_SHORT_TO_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Returns 0=Mon … 6=Sun for `now` as displayed in `timezone`. */
function getLocalWeekdayIndex(now, timezone) {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short',
  }).format(now);
  const idx = WEEKDAY_SHORT_TO_INDEX[short];
  if (idx === undefined) {
    throw new Error(`Unrecognized weekday "${short}" for timezone "${timezone}"`);
  }
  return idx;
}

/** Whether a recurring habit is due on the given local weekday. */
function isHabitDueOnWeekday(habit, weekdayIndex) {
  if (habit.repeatType === 'daily') return true;
  const days = habit.repeatDays || [];
  return days.includes(weekdayIndex);
}

/**
 * Whether a habit reminder should still exist/fire TODAY, in the given
 * timezone. Used as the last-moment re-validation right before a
 * `habit_reminder` is actually sent, so a habit archived, deleted, disabled,
 * or rescheduled AFTER its reminder was materialized never gets a stale
 * send (PHASE 2, scenario E of the ENMA habit-notification pre-deploy
 * review) — mirrors functions/src/index.ts's isHabitStillDueToday.
 */
function isHabitDueToday(habit, timezone, now = new Date()) {
  if (!habit) return false;
  if (habit.archived) return false;
  if (!habit.reminderTime) return false;
  return isHabitDueOnWeekday(habit, getLocalWeekdayIndex(now, timezone));
}

module.exports = { getLocalWeekdayIndex, isHabitDueOnWeekday, isHabitDueToday };
