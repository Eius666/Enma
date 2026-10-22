import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import HabitEditor from '../HabitEditor';
import type { HabitDoc } from '../HabitsList';

// The habit reminder time (BUG-05): a labelled time control that opens the
// system picker, shows the chosen time, saves it, restores it, can be changed
// or removed, and is discarded when the editor is left without saving.
// Firestore, the API and the device time zone are fakes.

const mockWrites: Array<{ path: string; data: Record<string, unknown> }> = [];
const mockCancelled: string[] = [];
const mockUserDoc: { data: Record<string, unknown> | undefined; fail: boolean; read: Promise<unknown> } = { data: undefined, fail: false, read: Promise.resolve() };

jest.mock('../../firebase', () => ({ db: { __db: true }, auth: {} }));
jest.mock('../../lib/timeZone', () => ({ deviceTimeZone: () => 'Europe/Moscow' }));
jest.mock('../../lib/usageCounters', () => ({ subscribeFreeUsage: () => () => undefined }));
jest.mock('../../lib/habitReminders', () => ({
  cancelTodayHabitReminder: async (id: string) => { mockCancelled.push(id); },
}));
jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
  getDoc: (ref: { __path: string }) => {
    const data = ref.__path.startsWith('users/') ? mockUserDoc.data : undefined;
    const read = mockUserDoc.fail
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ exists: () => data !== undefined, data: () => data });
    mockUserDoc.read = read.catch(() => undefined);
    return read;
  },
  setDoc: async (ref: { __path: string }, data: Record<string, unknown>) => { mockWrites.push({ path: ref.__path, data }); },
  updateDoc: async () => undefined,
  deleteDoc: async () => undefined,
  serverTimestamp: () => 'SERVER_TS',
}));

type Call = { url: string; body: { data: Record<string, unknown> } };
let apiCalls: Call[] = [];

beforeEach(() => {
  mockWrites.length = 0;
  mockCancelled.length = 0;
  mockUserDoc.data = { timezone: 'Europe/Moscow' };
  mockUserDoc.fail = false;
  apiCalls = [];
  global.fetch = (async (url: string, init?: { body?: string }) => {
    apiCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
});

const user = { uid: 'u1', getIdToken: async () => 'token' } as never;
const habit = (over: Partial<HabitDoc> = {}): HabitDoc => ({
  id: 'h1', userId: 'u1', title: 'Water', color: '#7B68EE', completedDates: [],
  repeatType: 'daily', repeatDays: [], archived: false, ...over,
});

// Waits for the editor's read of the stored time zone to settle.
async function openEditor(initial: HabitDoc | null = null, onBack = jest.fn()) {
  render(
    <HabitEditor habitId={initial?.id ?? null} initialHabit={initial} user={user} language="ru" subscription={null} onBack={onBack} />
  );
  await act(async () => { await mockUserDoc.read; });
  return onBack;
}
const timeInput = () => screen.getByLabelText('НАПОМИНАНИЕ') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
const habitWrite = () => mockWrites.find(w => w.path.startsWith('habits/'));

test('the reminder row is a labelled time control with a visible "not set" state', async () => {
  await openEditor();
  expect(timeInput().type).toBe('time');
  expect(timeInput()).toBeEnabled();
  expect(screen.getByText('Не задано')).toBeTruthy();
});

test('a chosen time is shown in the form and saved with a new habit', async () => {
  const onBack = await openEditor();
  fireEvent.change(screen.getByPlaceholderText('Название привычки'), { target: { value: 'Run' } });
  fireEvent.change(timeInput(), { target: { value: '07:30' } });
  expect(screen.getByText('07:30')).toBeTruthy();
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  const create = apiCalls.find(c => c.url.includes('/api/ai/entityCreate'))!;
  expect(create.body.data.reminderTime).toBe('07:30');
});

test.each(['00:00', '23:59'])('the boundary time %s is kept as it is', async (value) => {
  const onBack = await openEditor(habit());
  fireEvent.change(timeInput(), { target: { value } });
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(habitWrite()!.data.reminderTime).toBe(value);
});

test('reopening a habit restores its time; it can be changed', async () => {
  const onBack = await openEditor(habit({ reminderTime: '08:15' }));
  expect(timeInput().value).toBe('08:15');
  expect(screen.getByText('08:15')).toBeTruthy();
  fireEvent.change(timeInput(), { target: { value: '09:45' } });
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(habitWrite()!.data.reminderTime).toBe('09:45');
});

test('the time can be removed: saved as null and today\'s pending reminder is cancelled', async () => {
  const onBack = await openEditor(habit({ reminderTime: '08:15' }));
  fireEvent.click(screen.getByRole('button', { name: 'Убрать время напоминания' }));
  expect(screen.getByText('Не задано')).toBeTruthy();
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(habitWrite()!.data.reminderTime).toBeNull();
  expect(mockCancelled).toEqual(['h1']);
});

test('leaving the editor without saving writes nothing', async () => {
  const onBack = await openEditor(habit({ reminderTime: '08:15' }));
  fireEvent.change(timeInput(), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: /Привычки/ }));
  expect(onBack).toHaveBeenCalled();
  await new Promise(r => setTimeout(r, 0));
  expect(mockWrites).toEqual([]);
  expect(apiCalls).toEqual([]);
});

// ── time zone ────────────────────────────────────────────────────────────────

test('the hint names the zone the server will use', async () => {
  await openEditor(habit({ reminderTime: '08:15' }));
  expect(await screen.findByText('Время по часовому поясу Europe/Moscow')).toBeTruthy();
});

test('no zone stored yet: this device\'s zone is written on save, and only then', async () => {
  mockUserDoc.data = {};
  const onBack = await openEditor(habit());
  fireEvent.change(timeInput(), { target: { value: '07:00' } });
  await screen.findByText('Время по часовому поясу Europe/Moscow');
  expect(mockWrites).toEqual([]);
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(mockWrites.find(w => w.path === 'users/u1')!.data).toEqual({ timezone: 'Europe/Moscow', updatedAt: 'SERVER_TS' });
});

test('a different stored zone is never overwritten by saving; switching is an explicit action', async () => {
  mockUserDoc.data = { timezone: 'Asia/Almaty' };
  const onBack = await openEditor(habit({ reminderTime: '08:15' }));
  expect(await screen.findByText(/Время по часовому поясу Asia\/Almaty \(на устройстве — Europe\/Moscow\)/)).toBeTruthy();
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(mockWrites.filter(w => w.path === 'users/u1')).toEqual([]);
});

test('switching to the device zone writes it', async () => {
  mockUserDoc.data = { timezone: 'Asia/Almaty' };
  await openEditor(habit({ reminderTime: '08:15' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Использовать Europe/Moscow' }));
  await waitFor(() => expect(mockWrites.find(w => w.path === 'users/u1')?.data.timezone).toBe('Europe/Moscow'));
});

test('when the stored zone cannot be read nothing is claimed or written about it', async () => {
  mockUserDoc.fail = true;
  const onBack = await openEditor(habit());
  fireEvent.change(timeInput(), { target: { value: '07:00' } });
  save();
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(screen.queryByText(/часовому поясу/)).toBeNull();
  expect(mockWrites.filter(w => w.path === 'users/u1')).toEqual([]);
});

// ── required fields ─────────────────────────────────────────────────────────

test('save needs a name, and on chosen days at least one day', async () => {
  await openEditor();
  const saveBtn = screen.getByRole('button', { name: 'Сохранить' });
  expect(saveBtn).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText('Название привычки'), { target: { value: 'Run' } });
  expect(saveBtn).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать дни' }));
  expect(saveBtn).toBeDisabled();
  expect(screen.getByText('Выберите хотя бы один день')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ср' }));
  expect(saveBtn).toBeEnabled();
  // The reminder time itself is optional.
  expect(timeInput().value).toBe('');
});
