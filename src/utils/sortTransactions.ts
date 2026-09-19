import type { Transaction } from '../types/app';

function createdMs(tx: Transaction): number {
  const c = tx.createdAt as { toMillis?: () => number } | number | null | undefined;
  if (typeof c === 'number') return c;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  // Web and Telegram ids both start with the creation time in ms ("1789…-abc").
  const fromId = parseInt(String(tx.id).split('-')[0], 10);
  return Number.isFinite(fromId) ? fromId : 0;
}

/**
 * Newest first. Web transactions carry a date only (stored as local noon), so
 * many rows share the same `date` — creation time breaks the tie so the most
 * recently added operation is always on top.
 */
export function compareNewestFirst(a: Transaction, b: Transaction): number {
  const byDay = dayKey(b.date).localeCompare(dayKey(a.date));
  if (byDay !== 0) return byDay;
  return createdMs(b) - createdMs(a);
}

// Local calendar day. Web rows are "noon", Telegram rows carry the real time —
// comparing full timestamps would put a noon web row above a later Telegram
// row from the same day, so only the DAY is compared here.
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
