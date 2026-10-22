// The IANA time zone this device is set to ('Europe/Moscow'), or null when
// the runtime cannot tell (very old WebViews return nothing or 'UTC' only).
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : null;
  } catch {
    return null;
  }
}

// The zone the server reads a reminder time in when users/{uid}.timezone is
// not set (api/_lib/tools.js, api/_lib/firebaseAdmin.js, functions/src/index.ts;
// kept equal by src/lib/__tests__/timeZone.test.ts).
export const SERVER_DEFAULT_TIME_ZONE = 'Europe/Warsaw';

function wallClock(ms: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/**
 * The time a clock in `toZone` shows when a clock in `fromZone` shows `time`
 * ("HH:MM") on the day `now` falls on in `fromZone`: "09:00" in Europe/Warsaw
 * is "11:00" in Europe/Moscow in winter. Null for a bad time or zone.
 */
export function convertTime(time: string, fromZone: string, toZone: string, now: Date = new Date()): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  try {
    const day = wallClock(now.getTime(), fromZone);
    const wanted = Date.UTC(day.y, day.m - 1, day.d, Number(match[1]), Number(match[2]));
    // Correct the guess by the zone's offset at that moment.
    const seen = wallClock(wanted, fromZone);
    const offset = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min) - wanted;
    const there = wallClock(wanted - offset, toZone);
    return `${String(there.h).padStart(2, '0')}:${String(there.min).padStart(2, '0')}`;
  } catch {
    return null;
  }
}
