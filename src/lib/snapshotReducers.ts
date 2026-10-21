import type { Transaction as AnyTransaction } from '../types/app';
import { compareNewestFirst } from '../utils/sortTransactions';

// Pure reducers that fold a Firestore snapshot's docChanges() into the list the
// UI holds. Moved out of App.tsx unchanged so their behaviour can be tested
// without Firestore. They only use the parts of the snapshot API listed below.

export type SnapshotChange = {
  type: string;
  doc: { id: string; data(): Record<string, unknown> };
};
export type ChangesSnapshot = { docChanges(): SnapshotChange[] };

const createdAtSeconds = (value: unknown): number =>
  (value as { seconds?: number } | undefined)?.seconds ?? 0;

/**
 * Transactions: Firestore is the source of truth, so the FIRST snapshot
 * replaces whatever the localStorage cache put in state (deleted transactions
 * never linger); later snapshots merge. Sorted newest first.
 */
export function reduceTransactions<T extends AnyTransaction>(
  prev: T[],
  snapshot: ChangesSnapshot,
  isFirst: boolean
): T[] {
  const updated = new Map((isFirst ? [] : prev).map(t => [t.id, t]));
  snapshot.docChanges().forEach(change => {
    if (change.type === 'removed') {
      updated.delete(change.doc.id);
    } else {
      updated.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as unknown as T);
    }
  });
  return Array.from(updated.values()).sort(compareNewestFirst);
}

/** Habits and day tasks: merge changes into the current list, newest `createdAt` first. */
export function reduceByCreatedAtDesc<T extends { id: string; createdAt?: unknown }>(
  prev: T[],
  snapshot: ChangesSnapshot
): T[] {
  const map = new Map(prev.map(item => [item.id, item]));
  snapshot.docChanges().forEach(change => {
    if (change.type === 'removed') {
      map.delete(change.doc.id);
    } else {
      map.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as unknown as T);
    }
  });
  return Array.from(map.values()).sort(
    (a, b) => createdAtSeconds(b.createdAt) - createdAtSeconds(a.createdAt)
  );
}

type ReminderShape = {
  id: string; title: string; date: string; time: string; notes?: string; done: boolean;
};

/** Reminders: normalised fields, sorted by date then time. */
export function reduceReminders<T extends ReminderShape>(prev: T[], snapshot: ChangesSnapshot): T[] {
  const updated = new Map(prev.map(r => [r.id, r]));
  snapshot.docChanges().forEach(change => {
    if (change.type === 'removed') {
      updated.delete(change.doc.id);
    } else {
      const d = change.doc.data();
      updated.set(change.doc.id, {
        id: change.doc.id,
        title: String(d.title ?? ''),
        date: String(d.date ?? ''),
        time: String(d.time ?? '00:00'),
        notes: d.notes ? String(d.notes) : undefined,
        done: Boolean(d.done),
      } as unknown as T);
    }
  });
  return Array.from(updated.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
  );
}
