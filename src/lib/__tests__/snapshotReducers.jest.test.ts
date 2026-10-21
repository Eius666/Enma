import { reduceTransactions, reduceByCreatedAtDesc, reduceReminders } from '../snapshotReducers';
import type { ChangesSnapshot } from '../snapshotReducers';

// Minimal fake of the part of a Firestore QuerySnapshot the reducers use.
const snap = (changes: Array<[string, string, Record<string, unknown>?]>): ChangesSnapshot => ({
  docChanges: () => changes.map(([type, id, data]) => ({ type, doc: { id, data: () => data ?? {} } })),
});

type Tx = { id: string; type: 'income' | 'expense'; amount: number; categoryId: string; description: string; date: string };
const tx = (id: string, date: string, extra: Partial<Tx> = {}): Tx => ({
  id, type: 'expense', amount: 1, categoryId: 'c', description: '', date, ...extra,
});

describe('reduceTransactions', () => {
  test('the FIRST snapshot replaces cached state, so deleted transactions never linger', () => {
    const cached = [tx('stale-1', '2026-01-01'), tx('stale-2', '2026-01-02')];
    const next = reduceTransactions(cached, snap([['added', 'a', { ...tx('a', '2026-02-01') }]]), true);
    expect(next.map(t => t.id)).toEqual(['a']);
  });

  test('later snapshots merge into existing state', () => {
    const prev = [tx('a', '2026-02-01')];
    const next = reduceTransactions(prev, snap([['added', 'b', { ...tx('b', '2026-02-03') }]]), false);
    expect(next.map(t => t.id).sort()).toEqual(['a', 'b']);
  });

  test('modified replaces the item; removed deletes it', () => {
    const prev = [tx('a', '2026-02-01', { amount: 5 }), tx('b', '2026-02-02')];
    const next = reduceTransactions(
      prev,
      snap([['modified', 'a', { ...tx('a', '2026-02-01', { amount: 9 }) }], ['removed', 'b']]),
      false
    );
    expect(next).toHaveLength(1);
    expect(next[0].amount).toBe(9);
  });

  test('result is sorted newest first and never loses documents', () => {
    const changes: Array<[string, string, Record<string, unknown>]> = [
      ['added', 'old', { ...tx('old', '2026-01-01') }],
      ['added', 'new', { ...tx('new', '2026-03-01') }],
      ['added', 'mid', { ...tx('mid', '2026-02-01') }],
    ];
    expect(reduceTransactions([], snap(changes), true).map(t => t.id)).toEqual(['new', 'mid', 'old']);
  });

  test('an `id` stored inside the document data overrides the document id (existing behaviour, kept)', () => {
    const next = reduceTransactions([], snap([['added', 'real-id', { ...tx('x', '2026-01-01') }]]), true);
    expect(next[0].id).toBe('x'); // original spread order is {id, ...data}: stored data wins, as before
  });
});

describe('reduceByCreatedAtDesc (habits, day tasks)', () => {
  type Item = { id: string; createdAt?: { seconds?: number } };
  test('merges, removes and sorts by createdAt.seconds descending; missing createdAt sorts last', () => {
    const prev: Item[] = [{ id: 'a', createdAt: { seconds: 10 } }];
    const next = reduceByCreatedAtDesc<Item>(
      prev,
      snap([
        ['added', 'b', { createdAt: { seconds: 30 } }],
        ['added', 'c', {}],
        ['added', 'd', { createdAt: { seconds: 20 } }],
      ])
    );
    expect(next.map(i => i.id)).toEqual(['b', 'd', 'a', 'c']);
    const afterRemove = reduceByCreatedAtDesc<Item>(next, snap([['removed', 'b']]));
    expect(afterRemove.map(i => i.id)).toEqual(['d', 'a', 'c']);
  });

  test('does not drop items that are not mentioned in the snapshot changes', () => {
    const prev: Item[] = [{ id: 'a', createdAt: { seconds: 1 } }, { id: 'b', createdAt: { seconds: 2 } }];
    expect(reduceByCreatedAtDesc<Item>(prev, snap([])).map(i => i.id)).toEqual(['b', 'a']);
  });
});

describe('reduceReminders', () => {
  type R = { id: string; title: string; date: string; time: string; notes?: string; done: boolean };
  test('normalises fields, applies defaults, sorts by date then time', () => {
    const next = reduceReminders<R>([], snap([
      ['added', 'r2', { title: 'B', date: '2026-02-02', time: '09:00', done: 1 }],
      ['added', 'r1', { title: 'A', date: '2026-02-02', time: '08:00', notes: 'n' }],
      ['added', 'r0', { date: '2026-01-01' }],
    ]));
    expect(next.map(r => r.id)).toEqual(['r0', 'r1', 'r2']);
    expect(next[0]).toEqual({ id: 'r0', title: '', date: '2026-01-01', time: '00:00', notes: undefined, done: false });
    expect(next[1].notes).toBe('n');
    expect(next[2].done).toBe(true);
  });

  test('removal and untouched items', () => {
    const prev: R[] = [
      { id: 'a', title: 'a', date: '2026-01-01', time: '10:00', done: false },
      { id: 'b', title: 'b', date: '2026-01-02', time: '10:00', done: false },
    ];
    expect(reduceReminders<R>(prev, snap([['removed', 'a']])).map(r => r.id)).toEqual(['b']);
  });
});
