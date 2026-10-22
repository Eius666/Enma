import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertTime, SERVER_DEFAULT_TIME_ZONE } from '../timeZone.ts';

const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

test('the default zone shown in the app is the one the server falls back to', () => {
  for (const file of ['api/_lib/tools.js', 'api/_lib/firebaseAdmin.js', 'functions/src/index.ts']) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.equal(/DEFAULT_TZ\s*=\s*'([^']+)'/.exec(source)?.[1], SERVER_DEFAULT_TIME_ZONE, file);
  }
});

test('a reminder time is converted between zones, daylight saving included', () => {
  assert.equal(convertTime('09:00', 'Europe/Warsaw', 'Europe/Moscow', WINTER), '11:00');
  assert.equal(convertTime('09:00', 'Europe/Warsaw', 'Europe/Moscow', SUMMER), '10:00');
  assert.equal(convertTime('23:30', 'Europe/Warsaw', 'Asia/Almaty', WINTER), '03:30');
  assert.equal(convertTime('07:15', 'Europe/Warsaw', 'America/New_York', SUMMER), '01:15');
  assert.equal(convertTime('08:00', 'Europe/Moscow', 'Europe/Moscow', WINTER), '08:00');
});

test('a bad time or zone gives no conversion', () => {
  assert.equal(convertTime('9:00', 'Europe/Warsaw', 'Europe/Moscow', WINTER), null);
  assert.equal(convertTime('09:00', 'Not/AZone', 'Europe/Moscow', WINTER), null);
});

// The hint must name the moment the server will actually send: compare with
// the habit scheduler's own conversion (functions/src/habitSchedule.ts,
// compiled by `pretest:unit`) around the daylight-saving changes, including
// the skipped and the repeated hour.
test('the device time shown matches the moment the server schedules, across DST changes', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { localToUtc } = require('../../../functions/lib/habitSchedule.js');
  const days = ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26'];
  const times = ['00:00', '01:30', '02:00', '02:30', '03:00', '03:30', '09:00', '23:59'];
  const devices = ['Europe/Moscow', 'Asia/Almaty', 'America/New_York', 'Europe/London', 'Europe/Warsaw'];
  let checked = 0;
  for (const day of days) {
    for (const time of times) {
      const scheduled: Date = localToUtc(day, time, 'Europe/Warsaw');
      for (const device of devices) {
        const expected = new Intl.DateTimeFormat('en-GB', { timeZone: device, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(scheduled);
        assert.equal(convertTime(time, 'Europe/Warsaw', device, new Date(`${day}T12:00:00Z`)), expected, `${day} ${time} → ${device}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 240);
});
