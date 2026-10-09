// Shared helpers between HabitEditor (create/update/delete/archive) and
// App.tsx (the legacy client-side "today" scheduler) so both sides agree on
// the exact same reminders/{docId} naming scheme used by the server-side
// materializer (functions/src/habitSchedule.ts's habitReminderDocId) and on
// which local weekday a custom-days habit is due.
//
// 0=Mon … 6=Sun — matches HabitDoc.repeatDays (src/components/HabitsList.tsx)
// and the day-picker order in HabitEditor.tsx (['Mon','Tue',...,'Sun']).

import { doc, deleteDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

export function habitReminderDocId(habitId: string, dateKey: string): string {
  return `habit-${habitId}-${dateKey}`;
}

/** 0=Mon … 6=Sun for the device's local "now". */
export function getLocalWeekdayIndex(now: Date = new Date()): number {
  // JS getDay(): 0=Sun … 6=Sat. Shift so Monday is 0.
  return (now.getDay() + 6) % 7;
}

export function isHabitDueToday(
  habit: { repeatType: 'daily' | 'custom'; repeatDays?: number[] },
  now: Date = new Date()
): boolean {
  if (habit.repeatType !== 'custom') return true;
  const days = habit.repeatDays ?? [];
  return days.includes(getLocalWeekdayIndex(now));
}

/**
 * Cancels today's pending reminder for a habit, if one exists — e.g. when
 * the habit is deleted, archived, or has its reminder disabled. Never
 * touches a reminder that's already sending/sent/failed: by the time that
 * happens today's notification has already been handled one way or
 * another, so there's nothing left to cancel.
 */
export async function cancelTodayHabitReminder(habitId: string, today: string): Promise<void> {
  const ref = doc(db, 'reminders', habitReminderDocId(habitId, today));
  try {
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data()?.status === 'pending') {
      await deleteDoc(ref);
    }
  } catch (error) {
    console.warn('Failed to cancel today’s habit reminder', error);
  }
}
