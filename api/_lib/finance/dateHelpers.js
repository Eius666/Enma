'use strict';

// All functions respect user timezone — never use server TZ for financial periods.

function userToday(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // YYYY-MM-DD
}

function currentYearMonth(timezone) {
  return userToday(timezone).slice(0, 7); // YYYY-MM
}

function prevYearMonth(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Days until a YYYY-MM-DD date from today in user's timezone.
// Negative = past.
function daysUntil(dateStr, timezone) {
  const today   = userToday(timezone);
  const todayMs = new Date(today   + 'T12:00:00Z').getTime();
  const targMs  = new Date(dateStr + 'T12:00:00Z').getTime();
  return Math.round((targMs - todayMs) / 86_400_000);
}

// Whole months between two YYYY-MM strings (positive = b is later).
function monthsBetween(ymA, ymB) {
  const [yA, mA] = ymA.split('-').map(Number);
  const [yB, mB] = ymB.split('-').map(Number);
  return (yB - yA) * 12 + (mB - mA);
}

// Whole months from today's year-month to a deadline YYYY-MM-DD.
function monthsUntilDeadline(deadlineStr, timezone) {
  const todayYm = currentYearMonth(timezone);
  const deadYm  = deadlineStr.slice(0, 7);
  return monthsBetween(todayYm, deadYm);
}

// Normalize a transaction date to YYYY-MM-DD string.
function txDateStr(tx) {
  const raw = typeof tx.date === 'string' ? tx.date : new Date(tx.date).toISOString();
  return raw.slice(0, 10);
}

// Extract YYYY-MM from a transaction.
function txYearMonth(tx) {
  return txDateStr(tx).slice(0, 7);
}

// Days between two YYYY-MM-DD strings (positive = b is later).
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T12:00:00Z').getTime();
  const b = new Date(dateStrB + 'T12:00:00Z').getTime();
  return Math.round((b - a) / 86_400_000);
}

// Add N months to a YYYY-MM string, returns YYYY-MM.
function addMonths(yearMonth, n) {
  const [y, m] = yearMonth.split('-').map(Number);
  const total  = m - 1 + n;
  const ny     = y + Math.floor(total / 12);
  const nm     = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

module.exports = {
  userToday,
  currentYearMonth,
  prevYearMonth,
  daysUntil,
  monthsBetween,
  monthsUntilDeadline,
  txDateStr,
  txYearMonth,
  daysBetween,
  addMonths,
};
