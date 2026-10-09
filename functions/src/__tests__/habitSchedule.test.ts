import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLocalDateKey,
  getLocalWeekdayIndex,
  localToUtc,
  isHabitDueOnWeekday,
  habitReminderDocId,
  computeHabitOccurrence,
} from '../habitSchedule';

// ── getLocalDateKey / getLocalWeekdayIndex ──────────────────────────────────

test('getLocalDateKey reflects the timezone, not UTC, near a day boundary', () => {
  // 23:30 Moscow time on 2026-03-14 is 20:30 UTC — still the 14th in UTC too,
  // but 02:30 the *next* day in Asia/Shanghai (UTC+8).
  const instant = new Date('2026-03-14T20:30:00Z');
  assert.equal(getLocalDateKey(instant, 'Europe/Moscow'), '2026-03-14');
  assert.equal(getLocalDateKey(instant, 'Asia/Shanghai'), '2026-03-15');
});

test('getLocalWeekdayIndex maps Mon=0 … Sun=6', () => {
  // 2026-10-05 is a Monday.
  const monday = new Date('2026-10-05T12:00:00Z');
  assert.equal(getLocalWeekdayIndex(monday, 'UTC'), 0);
  const sunday = new Date('2026-10-11T12:00:00Z');
  assert.equal(getLocalWeekdayIndex(sunday, 'UTC'), 6);
});

test('getLocalWeekdayIndex can roll the day over relative to UTC', () => {
  // 2026-10-11 23:30 UTC is Sunday in UTC, but already Monday 2026-10-12 in
  // Asia/Shanghai (UTC+8) — the habit's "due day" must follow the user's TZ.
  const lateUtcSunday = new Date('2026-10-11T23:30:00Z');
  assert.equal(getLocalWeekdayIndex(lateUtcSunday, 'UTC'), 6);
  assert.equal(getLocalWeekdayIndex(lateUtcSunday, 'Asia/Shanghai'), 0);
});

// ── localToUtc ───────────────────────────────────────────────────────────────

test('localToUtc converts a plain local time to UTC', () => {
  // Europe/Warsaw is UTC+2 in July (summer/DST).
  const result = localToUtc('2026-07-30', '23:30', 'Europe/Warsaw');
  assert.equal(result.toISOString(), '2026-07-30T21:30:00.000Z');
});

test('localToUtc handles the winter (non-DST) offset correctly', () => {
  // Europe/Warsaw is UTC+1 in January.
  const result = localToUtc('2026-01-15', '09:00', 'Europe/Warsaw');
  assert.equal(result.toISOString(), '2026-01-15T08:00:00.000Z');
});

test('localToUtc is correct across the spring-forward DST transition', () => {
  // EU clocks spring forward on 2026-03-29 at 01:00 UTC (02:00→03:00 local).
  // A reminder at 09:00 local that day must use the POST-transition (+2) offset.
  const beforeDstDay = localToUtc('2026-03-28', '09:00', 'Europe/Warsaw'); // +1
  const afterDstDay   = localToUtc('2026-03-29', '09:00', 'Europe/Warsaw'); // +2
  assert.equal(beforeDstDay.toISOString(), '2026-03-28T08:00:00.000Z');
  assert.equal(afterDstDay.toISOString(),  '2026-03-29T07:00:00.000Z');
});

test('localToUtc handles a reminder just before midnight', () => {
  const result = localToUtc('2026-06-01', '23:55', 'Europe/Moscow'); // UTC+3
  assert.equal(result.toISOString(), '2026-06-01T20:55:00.000Z');
});

test('localToUtc round-trips through getLocalDateKey for the same instant', () => {
  const tz = 'Asia/Shanghai';
  const scheduledAt = localToUtc('2026-05-01', '09:00', tz);
  assert.equal(getLocalDateKey(scheduledAt, tz), '2026-05-01');
});

// ── isHabitDueOnWeekday ──────────────────────────────────────────────────────

test('a daily habit is due on every weekday', () => {
  for (let d = 0; d <= 6; d++) {
    assert.equal(isHabitDueOnWeekday({ repeatType: 'daily' }, d), true);
  }
});

test('a custom habit is due only on its selected days', () => {
  const habit = { repeatType: 'custom' as const, repeatDays: [0, 2, 4] }; // Mon/Wed/Fri
  assert.equal(isHabitDueOnWeekday(habit, 0), true);  // Mon
  assert.equal(isHabitDueOnWeekday(habit, 1), false); // Tue
  assert.equal(isHabitDueOnWeekday(habit, 4), true);  // Fri
  assert.equal(isHabitDueOnWeekday(habit, 6), false); // Sun
});

test('a custom habit with no days selected is never due', () => {
  const habit = { repeatType: 'custom' as const, repeatDays: [] };
  for (let d = 0; d <= 6; d++) {
    assert.equal(isHabitDueOnWeekday(habit, d), false);
  }
});

test('a custom habit with repeatDays missing entirely is never due', () => {
  const habit = { repeatType: 'custom' as const };
  assert.equal(isHabitDueOnWeekday(habit, 3), false);
});

// ── habitReminderDocId ───────────────────────────────────────────────────────

test('habitReminderDocId matches the legacy client-side scheme exactly', () => {
  // src/App.tsx: `habit-${habit.id}-${today}` — any drift here would create
  // duplicate reminders for the same habit/day instead of sharing one slot.
  assert.equal(habitReminderDocId('abc123', '2026-10-09'), 'habit-abc123-2026-10-09');
});

// ── computeHabitOccurrence ───────────────────────────────────────────────────

test('computeHabitOccurrence resolves a due daily habit', () => {
  const now = new Date('2026-10-05T06:00:00Z'); // Monday
  const occ = computeHabitOccurrence(
    'habit1',
    { repeatType: 'daily', reminderTime: '09:00' },
    'Europe/Moscow',
    now
  );
  assert.ok(occ);
  assert.equal(occ!.dateKey, '2026-10-05');
  assert.equal(occ!.docId, 'habit-habit1-2026-10-05');
  assert.equal(occ!.scheduledAt.toISOString(), '2026-10-05T06:00:00.000Z'); // 09:00 MSK = 06:00 UTC
});

test('computeHabitOccurrence returns null for an archived habit', () => {
  const occ = computeHabitOccurrence(
    'habit1',
    { repeatType: 'daily', reminderTime: '09:00', archived: true },
    'Europe/Moscow'
  );
  assert.equal(occ, null);
});

test('computeHabitOccurrence returns null when reminders are disabled', () => {
  const occ = computeHabitOccurrence(
    'habit1',
    { repeatType: 'daily', reminderTime: null },
    'Europe/Moscow'
  );
  assert.equal(occ, null);
});

test('computeHabitOccurrence returns null on a day not selected for a custom habit', () => {
  const tuesday = new Date('2026-10-06T06:00:00Z');
  const occ = computeHabitOccurrence(
    'habit1',
    { repeatType: 'custom', repeatDays: [0, 2, 4], reminderTime: '18:00' }, // Mon/Wed/Fri
    'Europe/Moscow',
    tuesday
  );
  assert.equal(occ, null);
});

test('computeHabitOccurrence resolves a due day for a custom habit', () => {
  const wednesday = new Date('2026-10-07T06:00:00Z');
  const occ = computeHabitOccurrence(
    'habit1',
    { repeatType: 'custom', repeatDays: [0, 2, 4], reminderTime: '18:00' },
    'Europe/Moscow',
    wednesday
  );
  assert.ok(occ);
  assert.equal(occ!.dateKey, '2026-10-07');
});
