import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DayTaskEditor from '../DayTaskEditor';
import type { DayTask } from '../../lib/dayTask';

// The task time uses the same time row as the habit reminder (BUG-05 check of
// similar pickers): labelled, shows the value, optional, removable.

const mockWrites: Array<{ path: string; data: Record<string, unknown> }> = [];

jest.mock('../../firebase', () => ({ db: { __db: true }, auth: {} }));
jest.mock('../../lib/usageCounters', () => ({ subscribeFreeUsage: () => () => undefined }));
jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
  setDoc: async (ref: { __path: string }, data: Record<string, unknown>) => { mockWrites.push({ path: ref.__path, data }); },
  updateDoc: async () => undefined,
  deleteDoc: async () => undefined,
  serverTimestamp: () => 'SERVER_TS',
}));

type Call = { url: string; body: { timeZone?: string; data: Record<string, unknown> } };
let apiCalls: Call[] = [];

beforeEach(() => {
  mockWrites.length = 0;
  apiCalls = [];
  global.fetch = (async (url: string, init?: { body?: string }) => {
    apiCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
});

const user = { uid: 'u1', getIdToken: async () => 'token' } as never;
const task: DayTask = { id: 't1', userId: 'u1', title: 'Call', date: '2026-10-23', time: '18:45', priority: 'medium', completed: false };
const timeInput = () => screen.getByLabelText('ВРЕМЯ') as HTMLInputElement;

test('a new task: the time is optional, shown when chosen, and sent with the device time zone', async () => {
  const onBack = jest.fn();
  render(<DayTaskEditor taskId={null} initialDate="2026-10-23" user={user} language="ru" subscription={null} onBack={onBack} />);
  expect(screen.getByText('Без времени')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('Название задачи'), { target: { value: 'Call' } });
  fireEvent.change(timeInput(), { target: { value: '18:45' } });
  expect(screen.getByText('18:45')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  const create = apiCalls.find(c => c.url.includes('/api/ai/entityCreate'))!;
  expect(create.body.data.time).toBe('18:45');
  expect(typeof create.body.timeZone).toBe('string');
});

test('an existing task: its time is restored and can be removed', async () => {
  const onBack = jest.fn();
  render(<DayTaskEditor taskId="t1" initialTask={task} user={user} language="ru" subscription={null} onBack={onBack} />);
  expect(timeInput().value).toBe('18:45');
  fireEvent.click(screen.getByRole('button', { name: 'Убрать время' }));
  expect(screen.getByText('Без времени')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(mockWrites.find(w => w.path === 'tasks/t1')!.data.time).toBeNull();
});
