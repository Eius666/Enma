'use strict';

// api/ and functions/ are separate deploy targets and each keeps its own copy
// of the habit "is it due today" rule (see api/_lib/habits/habitSchedule.js).
// This contract test runs BOTH implementations over the same inputs — timezone
// boundaries, week boundaries, DST changes, every repeat configuration — and
// fails if they ever disagree, so the two copies cannot drift apart silently.
//
// functions/lib is the compiled output of functions/src (the `pretest:unit`
// script builds it before `npm run test:unit`).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const api = require('../habitSchedule');
const fn = require('../../../../functions/lib/habitSchedule');

const ZONES = [
  'UTC', 'Europe/Moscow', 'Asia/Vladivostok', 'Pacific/Kiritimati', 'Pacific/Pago_Pago',
  'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/Berlin',
];

// Instants around local midnight, week boundaries and DST transitions of 2026.
const INSTANTS = [
  '2026-01-01T00:00:00Z', '2026-01-01T23:59:59Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:01Z',
  '2026-03-29T00:59:59Z', '2026-03-29T01:00:01Z', '2026-04-05T15:30:00Z', '2026-10-24T22:00:00Z',
  '2026-10-25T00:59:59Z', '2026-10-25T01:00:01Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:01Z',
  '2026-02-28T23:59:59Z', '2026-03-01T00:00:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z',
  '2026-10-21T12:00:00Z', '2026-10-18T21:30:00Z', '2026-10-19T00:00:00Z', '2026-10-25T23:59:59Z',
].map(s => new Date(s));

const HABITS = [
  { repeatType: 'daily', reminderTime: '08:00' },
  { repeatType: 'daily', reminderTime: '00:00' },
  { repeatType: 'daily', reminderTime: '23:59' },
  { repeatType: 'custom', repeatDays: [0, 2, 4], reminderTime: '09:30' },
  { repeatType: 'custom', repeatDays: [6], reminderTime: '21:00' },
  { repeatType: 'custom', repeatDays: [], reminderTime: '10:00' },
  { repeatType: 'custom', reminderTime: '10:00' },
  { repeatType: 'custom', repeatDays: [0, 1, 2, 3, 4, 5, 6], reminderTime: '12:00' },
  { repeatType: 'daily', reminderTime: '08:00', archived: true },
  { repeatType: 'daily', reminderTime: null },
  { repeatType: 'daily' },
  { repeatType: 'custom', repeatDays: [5, 6], reminderTime: '', archived: false },
];

test('weekday index is identical in both implementations for every zone and instant', () => {
  for (const tz of ZONES) {
    for (const now of INSTANTS) {
      assert.equal(api.getLocalWeekdayIndex(now, tz), fn.getLocalWeekdayIndex(now, tz), `${tz} @ ${now.toISOString()}`);
    }
  }
});

test('isHabitDueOnWeekday is identical for every weekday and repeat configuration', () => {
  for (const habit of HABITS) {
    for (let day = 0; day < 7; day++) {
      assert.equal(api.isHabitDueOnWeekday(habit, day), fn.isHabitDueOnWeekday(habit, day), JSON.stringify([habit, day]));
    }
  }
});

test('"still due today" (api/cron) agrees with the Functions decision (resolveHabitOccurrence.due, no createdAt)', () => {
  let compared = 0;
  for (const tz of ZONES) {
    for (const now of INSTANTS) {
      for (const habit of HABITS) {
        const fromApi = api.isHabitDueToday(habit, tz, now);
        const fromFunctions = fn.resolveHabitOccurrence('h1', habit, tz, now).due;
        assert.equal(fromApi, fromFunctions, `${tz} @ ${now.toISOString()} ${JSON.stringify(habit)}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 2000);
});

test('a missing habit (deleted) is never due on the api side', () => {
  assert.equal(api.isHabitDueToday(null, 'UTC'), false);
  assert.equal(api.isHabitDueToday(undefined, 'UTC'), false);
});

test('documented difference: only the Functions side also suppresses reminders that predate the habit creation time', () => {
  const habit = { repeatType: 'daily', reminderTime: '08:00' };
  const now = new Date('2026-10-21T12:00:00Z');
  const createdAfterReminder = new Date('2026-10-21T10:00:00Z'); // 08:00 UTC already passed before creation
  assert.equal(api.isHabitDueToday(habit, 'UTC', now), true);
  assert.equal(fn.resolveHabitOccurrence('h1', habit, 'UTC', now, createdAfterReminder).due, false);
});
