import { renderHook, act } from '@testing-library/react';
import type { User } from 'firebase/auth';
import { useSubscription } from '../useSubscription';

const mockCalls: Array<{ path: string; next: (s: unknown) => void; error: (e: unknown) => void; unsub: jest.Mock }> = [];
jest.mock('../../firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, collectionName: string, id: string) => `${collectionName}/${id}`,
  onSnapshot: (path: string, next: (s: unknown) => void, error: (e: unknown) => void) => {
    const unsub = jest.fn();
    mockCalls.push({ path, next, error, unsub });
    return unsub;
  },
}));

const user = (uid: string) => ({ uid }) as unknown as User;
const existing = (data: unknown) => ({ exists: () => true, data: () => data });
const missing = { exists: () => false, data: () => undefined };

beforeEach(() => { mockCalls.length = 0; });

test('no user: null subscription and no listener', () => {
  const { result } = renderHook(() => useSubscription(null));
  expect(result.current[0]).toBeNull();
  expect(mockCalls).toHaveLength(0);
});

test('listens to subscriptions/{uid} and mirrors the document (present, then deleted)', () => {
  const { result } = renderHook(() => useSubscription(user('u1')));
  expect(mockCalls.map(c => c.path)).toEqual(['subscriptions/u1']);
  act(() => mockCalls[0].next(existing({ plan: 'pro', status: 'active' })));
  expect(result.current[0]).toMatchObject({ plan: 'pro' });
  act(() => mockCalls[0].next(missing));
  expect(result.current[0]).toBeNull();
});

test('the setter is exposed for server-confirmed updates from the UI', () => {
  const { result } = renderHook(() => useSubscription(user('u1')));
  act(() => result.current[1]({ plan: 'premium' } as never));
  expect(result.current[0]).toMatchObject({ plan: 'premium' });
});

test('sign-out clears the subscription and unsubscribes; unmount unsubscribes', () => {
  const u = user('u1');
  const { result, rerender, unmount } = renderHook(({ current }) => useSubscription(current), { initialProps: { current: u as User | null } });
  act(() => mockCalls[0].next(existing({ plan: 'pro' })));
  rerender({ current: null });
  expect(mockCalls[0].unsub).toHaveBeenCalledTimes(1);
  expect(result.current[0]).toBeNull();
  rerender({ current: user('u2') });
  expect(mockCalls).toHaveLength(2);
  unmount();
  expect(mockCalls[1].unsub).toHaveBeenCalledTimes(1);
});

test('listener errors are logged, not thrown', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  renderHook(() => useSubscription(user('u1')));
  expect(() => mockCalls[0].error(new Error('denied'))).not.toThrow();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
