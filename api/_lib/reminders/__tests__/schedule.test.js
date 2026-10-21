'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidTimeZone, localToUtc, resolveReminderSchedule } = require('../schedule');

const iso = (d) => d.toISOString();
const NOW = Date.parse('2026-10-21T12:00:00Z');

test('plain conversions in several zones (including half-hour and +14)', () => {
  assert.equal(iso(localToUtc('2026-10-21', '20:00', 'Europe/Moscow')), '2026-10-21T17:00:00.000Z');
  assert.equal(iso(localToUtc('2026-10-21', '20:00', 'America/New_York')), '2026-10-22T00:00:00.000Z');
  assert.equal(iso(localToUtc('2026-10-21', '00:00', 'Asia/Kolkata')), '2026-10-20T18:30:00.000Z');
  assert.equal(iso(localToUtc('2026-10-21', '23:59', 'Pacific/Kiritimati')), '2026-10-21T09:59:00.000Z');
  assert.equal(iso(localToUtc('2026-12-31', '23:30', 'UTC')), '2026-12-31T23:30:00.000Z');
});

test('midnight and day rollover: the UTC date differs from the local date', () => {
  assert.equal(iso(localToUtc('2026-01-01', '00:00', 'Asia/Tokyo')), '2025-12-31T15:00:00.000Z');
  assert.equal(iso(localToUtc('2026-12-31', '23:59', 'America/Los_Angeles')), '2027-01-01T07:59:00.000Z');
});

test('DST spring-forward gap resolves just after the gap (02:30 does not exist -> 03:30 local)', () => {
  assert.equal(iso(localToUtc('2026-03-08', '02:30', 'America/New_York')), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(localToUtc('2026-03-29', '02:30', 'Europe/Berlin')), '2026-03-29T01:30:00.000Z');
});

test('DST fall-back ambiguous hour resolves to the earlier occurrence', () => {
  assert.equal(iso(localToUtc('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(localToUtc('2026-10-25', '02:30', 'Europe/Berlin')), '2026-10-25T00:30:00.000Z');
});

test('times right after a transition use the new offset', () => {
  assert.equal(iso(localToUtc('2026-03-08', '03:30', 'America/New_York')), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(localToUtc('2026-11-01', '03:00', 'America/New_York')), '2026-11-01T08:00:00.000Z');
});

test('future dates months away use the offset in force THEN, not now', () => {
  // New York is UTC-4 now (October) and UTC-5 in January.
  assert.equal(iso(localToUtc('2027-01-15', '09:00', 'America/New_York')), '2027-01-15T14:00:00.000Z');
});

test('half-hour DST zone (Lord Howe)', () => {
  assert.equal(iso(localToUtc('2026-04-05', '02:15', 'Australia/Lord_Howe')), '2026-04-04T15:45:00.000Z');
});

test('isValidTimeZone accepts IANA names and rejects junk', () => {
  for (const ok of ['UTC', 'Europe/Moscow', 'America/Argentina/Buenos_Aires']) assert.equal(isValidTimeZone(ok), true, ok);
  for (const bad of ['', 'Moscow', 'Mars/Olympus', 'Europe/Moscow; DROP', null, undefined, 5, 'x'.repeat(100)]) assert.equal(isValidTimeZone(bad), false, String(bad));
});

test('resolve: the client zone wins over the stored zone and is reported as the source', () => {
  const r = resolveReminderSchedule({ date: '2026-10-21', time: '20:00', clientTimeZone: 'Asia/Almaty', userTimeZone: 'Europe/Moscow', nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'client');
  assert.equal(iso(r.scheduledAt), '2026-10-21T15:00:00.000Z');
});

test('resolve: falls back to the stored zone when the client sent none or an invalid one', () => {
  for (const client of [undefined, '', 'nonsense']) {
    const r = resolveReminderSchedule({ date: '2026-10-21', time: '20:00', clientTimeZone: client, userTimeZone: 'Europe/Moscow', nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'user');
    assert.equal(iso(r.scheduledAt), '2026-10-21T17:00:00.000Z');
  }
});

test('resolve: NEVER guesses — no valid zone means timezone_unknown (no default to Moscow)', () => {
  const r = resolveReminderSchedule({ date: '2026-10-21', time: '20:00', nowMs: NOW });
  assert.deepEqual(r, { ok: false, reason: 'timezone_unknown' });
  assert.deepEqual(resolveReminderSchedule({ date: '2026-10-21', time: '20:00', userTimeZone: 'bad', nowMs: NOW }), { ok: false, reason: 'timezone_unknown' });
});

test('resolve: past instants are refused (a user in UTC-5 typing a time that is already past there)', () => {
  assert.deepEqual(resolveReminderSchedule({ date: '2026-10-21', time: '06:00', clientTimeZone: 'America/New_York', nowMs: NOW }), { ok: false, reason: 'in_the_past' });
  // The SAME wall-clock time is in the future in a zone far enough east.
  assert.equal(resolveReminderSchedule({ date: '2026-10-21', time: '22:00', clientTimeZone: 'Asia/Tokyo', nowMs: NOW }).ok, true);
});

test('resolve: malformed or impossible dates and times are invalid_datetime', () => {
  for (const [date, time] of [['2026-13-01', '10:00'], ['2026-02-30', '10:00'], ['21-10-2026', '10:00'], ['2026-10-21', '24:00'], ['2026-10-21', '9:00'], ['2026-10-21', '10:60'], [null, '10:00'], ['2026-10-21', undefined], ['2026-10-21', '10:00:00']]) {
    assert.deepEqual(resolveReminderSchedule({ date, time, clientTimeZone: 'UTC', nowMs: NOW }), { ok: false, reason: 'invalid_datetime' }, `${date} ${time}`);
  }
});

test('property: for every real zone the result, shown back in that zone, reads the typed wall-clock time (outside DST gaps)', () => {
  const fmt = (utc, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(utc).replace(',', '');
  for (const tz of ['UTC', 'Europe/Moscow', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland', 'Europe/London']) {
    for (const [d, t] of [['2026-06-15', '12:00'], ['2026-12-15', '08:45'], ['2027-02-01', '23:15'], ['2026-09-30', '00:05']]) {
      assert.equal(fmt(localToUtc(d, t, tz), tz), `${d} ${t}`, `${tz} ${d} ${t}`);
    }
  }
});
