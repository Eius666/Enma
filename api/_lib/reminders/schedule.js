'use strict';

// Turns the wall-clock date/time a user typed into an absolute UTC instant.
//
// The time zone is never guessed: it must be a valid IANA zone sent by the
// client (the device's zone, where the user typed the time) or the zone stored
// on the user. If neither is known the caller gets `timezone_unknown` and must
// not create a reminder.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch { return false; }
}

/**
 * The UTC instant at which a clock in `timezone` shows `dateStr` `timeStr`.
 * DST: a time that does not exist (spring-forward gap) resolves to the instant
 * after the gap (e.g. 02:30 -> 03:30 local); an ambiguous time (fall-back
 * hour) resolves to the earlier occurrence.
 */
function localToUtc(dateStr, timeStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, h, min);
  const offsetAt = (utcMs) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(utcMs));
    const p = {};
    for (const { type, value } of parts) if (type !== 'literal') p[type] = parseInt(value, 10);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(utcMs / 60000) * 60000;
  };
  // Candidate instants under the offsets in force a day before and a day after
  // (at most one transition fits in that span). A candidate is valid when the
  // zone really is at that offset at that instant.
  const DAY = 24 * 3600 * 1000;
  const offsets = [...new Set([offsetAt(wanted - DAY), offsetAt(wanted + DAY)])];
  const valid = offsets
    .map(off => wanted - off)
    .filter(utcMs => offsetAt(utcMs) === wanted - utcMs);
  if (valid.length > 0) return new Date(Math.min(...valid)); // ambiguous hour: the earlier instant
  // Gap (clock jumped forward over this local time): use the offset from before the gap,
  // which lands just after it (02:30 -> 03:30 local).
  return new Date(wanted - offsetAt(wanted - DAY));
}

/**
 * @returns {{ok:true, scheduledAt:Date, timeZone:string, source:'client'|'user'}
 *          |{ok:false, reason:'invalid_datetime'|'timezone_unknown'|'in_the_past'}}
 */
function resolveReminderSchedule({ date, time, clientTimeZone, userTimeZone, nowMs = Date.now() }) {
  if (typeof date !== 'string' || !DATE_RE.test(date) || typeof time !== 'string' || !TIME_RE.test(time)) {
    return { ok: false, reason: 'invalid_datetime' };
  }
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return { ok: false, reason: 'invalid_datetime' };
  }
  let timeZone = null;
  let source = null;
  if (isValidTimeZone(clientTimeZone)) { timeZone = clientTimeZone; source = 'client'; }
  else if (isValidTimeZone(userTimeZone)) { timeZone = userTimeZone; source = 'user'; }
  if (!timeZone) return { ok: false, reason: 'timezone_unknown' };

  const scheduledAt = localToUtc(date, time, timeZone);
  if (scheduledAt.getTime() <= nowMs) return { ok: false, reason: 'in_the_past' };
  return { ok: true, scheduledAt, timeZone, source };
}

module.exports = { isValidTimeZone, localToUtc, resolveReminderSchedule };
