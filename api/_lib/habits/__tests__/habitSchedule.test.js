'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getLocalWeekdayIndex, isHabitDueOnWeekday, isHabitDueToday } = require('../habitSchedule');

// Mirrors functions/src/__tests__/habitSchedule.test.ts's coverage for the
// equivalent logic — kept in sync since this is an independent CommonJS port.

test('getLocalWeekdayIndex maps Mon=0 … Sun=6', () => {
  const monday = new Date('2026-10-05T12:00:00Z');
  assert.equal(getLocalWeekdayIndex(monday, 'UTC'), 0);
  const sunday = new Date('2026-10-11T12:00:00Z');
  assert.equal(getLocalWeekdayIndex(sunday, 'UTC'), 6);
});

test('getLocalWeekdayIndex can roll the day over relative to UTC', () => {
  const lateUtcSunday = new Date('2026-10-11T23:30:00Z');
  assert.equal(getLocalWeekdayIndex(lateUtcSunday, 'UTC'), 6);
  assert.equal(getLocalWeekdayIndex(lateUtcSunday, 'Asia/Shanghai'), 0);
});

test('a daily habit is due on every weekday', () => {
  for (let d = 0; d <= 6; d++) {
    assert.equal(isHabitDueOnWeekday({ repeatType: 'daily' }, d), true);
  }
});

test('a custom habit is due only on its selected days', () => {
  const habit = { repeatType: 'custom', repeatDays: [0, 2, 4] };
  assert.equal(isHabitDueOnWeekday(habit, 0), true);
  assert.equal(isHabitDueOnWeekday(habit, 1), false);
});

test('isHabitDueToday is false for a missing habit', () => {
  assert.equal(isHabitDueToday(null, 'Europe/Moscow'), false);
  assert.equal(isHabitDueToday(undefined, 'Europe/Moscow'), false);
});

test('isHabitDueToday is false for an archived habit', () => {
  const habit = { repeatType: 'daily', reminderTime: '09:00', archived: true };
  assert.equal(isHabitDueToday(habit, 'Europe/Moscow'), false);
});

test('isHabitDueToday is false when reminders are disabled', () => {
  const habit = { repeatType: 'daily', reminderTime: null };
  assert.equal(isHabitDueToday(habit, 'Europe/Moscow'), false);
});

test('isHabitDueToday is false on a day not selected for a custom habit', () => {
  const tuesday = new Date('2026-10-06T06:00:00Z'); // Tuesday in Europe/Moscow too
  const habit = { repeatType: 'custom', repeatDays: [0, 2, 4], reminderTime: '18:00' }; // Mon/Wed/Fri
  assert.equal(isHabitDueToday(habit, 'Europe/Moscow', tuesday), false);
});

test('isHabitDueToday is true for an active daily habit', () => {
  const now = new Date('2026-10-06T06:00:00Z');
  const habit = { repeatType: 'daily', reminderTime: '09:00' };
  assert.equal(isHabitDueToday(habit, 'Europe/Moscow', now), true);
});
