import { renderHook, act } from '@testing-library/react';
import { useCollectionListener } from '../useCollectionListener';
import type { ChangesSnapshot } from '../../lib/snapshotReducers';

const mockListeners: Array<{
  onNext: (s: unknown) => void; onError: (e: unknown) => void; unsub: jest.Mock;
}> = [];
const mockQueries: Array<{ collection: string; uid: unknown }> = [];

jest.mock('../../firebase', () => ({ db: { __db: true } }));
jest.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ __collection: name }),
  where: (_field: string, _op: string, value: unknown) => ({ __where: value }),
  query: (c: { __collection: string }, w: { __where: unknown }) => {
    mockQueries.push({ collection: c.__collection, uid: w.__where });
    return { __query: true };
  },
  onSnapshot: (_q: unknown, onNext: (s: unknown) => void, onError: (e: unknown) => void) => {
    const unsub = jest.fn();
    mockListeners.push({ onNext, onError, unsub });
    return unsub;
  },
}));

type Item = { id: string };
const reduce = (prev: Item[], snapshot: ChangesSnapshot, isFirst: boolean): Item[] => [
  ...(isFirst ? [] : prev),
  ...snapshot.docChanges().map(c => ({ id: c.doc.id })),
];
const labels = { snapshotError: 'snapshot error', subscribeError: 'subscribe error' };
const snapshotOf = (...ids: string[]) => ({ docChanges: () => ids.map(id => ({ type: 'added', doc: { id, data: () => ({}) } })) });

beforeEach(() => {
  jest.useFakeTimers();
  mockListeners.length = 0;
  mockQueries.length = 0;
});
afterEach(() => jest.useRealTimers());

test('does nothing without a uid', () => {
  renderHook(() => useCollectionListener<Item>(null, 'habits', jest.fn(), reduce, labels));
  act(() => { jest.advanceTimersByTime(1000); });
  expect(mockListeners).toHaveLength(0);
});

test('subscribes after the start delay with the userId filter, and applies snapshots through the reducer', () => {
  const setState = jest.fn();
  renderHook(() => useCollectionListener<Item>('u1', 'habits', setState, reduce, labels));
  expect(mockListeners).toHaveLength(0);
  act(() => { jest.advanceTimersByTime(99); });
  expect(mockListeners).toHaveLength(0);
  act(() => { jest.advanceTimersByTime(1); });
  expect(mockListeners).toHaveLength(1);
  expect(mockQueries).toEqual([{ collection: 'habits', uid: 'u1' }]);

  mockListeners[0].onNext(snapshotOf('a'));
  const first = setState.mock.calls[0][0];
  expect(first([{ id: 'stale' }])).toEqual([{ id: 'a' }]); // first snapshot: isFirst = true
  mockListeners[0].onNext(snapshotOf('b'));
  const second = setState.mock.calls[1][0];
  expect(second([{ id: 'a' }])).toEqual([{ id: 'a' }, { id: 'b' }]); // later: isFirst = false
});

test('unmount before the delay cancels the subscription entirely', () => {
  const { unmount } = renderHook(() => useCollectionListener<Item>('u1', 'tasks', jest.fn(), reduce, labels));
  unmount();
  act(() => { jest.advanceTimersByTime(1000); });
  expect(mockListeners).toHaveLength(0);
});

test('unmount after subscribing unsubscribes exactly once, and late snapshots are ignored', () => {
  const setState = jest.fn();
  const { unmount } = renderHook(() => useCollectionListener<Item>('u1', 'tasks', setState, reduce, labels));
  act(() => { jest.advanceTimersByTime(100); });
  unmount();
  expect(mockListeners[0].unsub).toHaveBeenCalledTimes(1);
  mockListeners[0].onNext(snapshotOf('late'));
  expect(setState).not.toHaveBeenCalled();
});

test('changing the user re-subscribes and cleans up the previous listener (no duplicate listeners)', () => {
  const { rerender } = renderHook(({ uid }) => useCollectionListener<Item>(uid, 'reminders', jest.fn(), reduce, labels), {
    initialProps: { uid: 'u1' },
  });
  act(() => { jest.advanceTimersByTime(100); });
  rerender({ uid: 'u2' });
  expect(mockListeners[0].unsub).toHaveBeenCalledTimes(1);
  act(() => { jest.advanceTimersByTime(100); });
  expect(mockListeners).toHaveLength(2);
  expect(mockQueries.map(q => q.uid)).toEqual(['u1', 'u2']);
  rerender({ uid: 'u2' }); // same user: no churn
  act(() => { jest.advanceTimersByTime(500); });
  expect(mockListeners).toHaveLength(2);
});

test('listener errors are logged with the given label and never thrown', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  renderHook(() => useCollectionListener<Item>('u1', 'habits', jest.fn(), reduce, labels));
  act(() => { jest.advanceTimersByTime(100); });
  expect(() => mockListeners[0].onError(new Error('permission-denied'))).not.toThrow();
  expect(warn).toHaveBeenCalledWith('snapshot error', expect.any(Error));
  warn.mockRestore();
});
