import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NoteEditor from '../NoteEditor';

// BUG-06, editor side: the folder a new note is opened with reaches the
// create request; an existing note keeps its own folder when edited.
// Firestore and the API are fakes.

const mockDocs: Record<string, Record<string, unknown>> = {};
const mockTxWrites: Array<{ path: string; data: Record<string, unknown> }> = [];

jest.mock('../../firebase', () => ({ db: { __db: true }, auth: {} }));
jest.mock('../../lib/usageCounters', () => ({ subscribeFreeUsage: () => () => undefined }));
jest.mock('firebase/firestore', () => {
  const snap = (path: string) => ({ exists: () => path in mockDocs, data: () => mockDocs[path] });
  return {
    doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
    getDoc: async (ref: { __path: string }) => snap(ref.__path),
    deleteDoc: async () => undefined,
    serverTimestamp: () => 'SERVER_TS',
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { __path: string }) => snap(ref.__path),
      set: (ref: { __path: string }, data: Record<string, unknown>) => { mockTxWrites.push({ path: ref.__path, data }); },
    }),
  };
});

let creates: Array<{ data: Record<string, unknown> }> = [];
beforeEach(() => {
  for (const k of Object.keys(mockDocs)) delete mockDocs[k];
  mockTxWrites.length = 0;
  creates = [];
  global.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes('/api/ai/entityCreate')) creates.push(JSON.parse(init?.body ?? '{}'));
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'x' }) };
  }) as unknown as typeof fetch;
});

const user = { uid: 'u1', getIdToken: async () => 'token' } as never;

test('a new note opened in a folder is created in that folder', async () => {
  render(<NoteEditor noteId={null} initialCategory="Личное" user={user} language="ru" subscription={null} onBack={() => undefined} />);
  fireEvent.change(await screen.findByPlaceholderText('Заголовок'), { target: { value: 'Мысли' } });
  await waitFor(() => expect(creates).toHaveLength(1), { timeout: 3000 });
  expect(creates[0].data.category).toBe('Личное');
  expect(creates[0].data.title).toBe('Мысли');
});

test('editing an existing note keeps its folder, whatever folder the list had open', async () => {
  mockDocs['notes/n2'] = { userId: 'u1', title: 'Plan', content: '', type: 'text', checklistItems: [], category: 'Проект', pinned: false, rev: 3 };
  render(<NoteEditor noteId="n2" user={user} language="ru" subscription={null} onBack={() => undefined} />);
  const title = await screen.findByDisplayValue('Plan');
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  fireEvent.change(title, { target: { value: 'Plan v2' } });
  await waitFor(() => expect(mockTxWrites).toHaveLength(1), { timeout: 3000 });
  expect(mockTxWrites[0].path).toBe('notes/n2');
  expect(mockTxWrites[0].data.category).toBe('Проект');
  expect(mockTxWrites[0].data.title).toBe('Plan v2');
});

test('the category menu shows a folder of the user\'s own as the selected one', async () => {
  mockDocs['notes/n2'] = { userId: 'u1', title: 'Plan', content: '', type: 'text', checklistItems: [], category: 'Проект', pinned: false };
  render(<NoteEditor noteId="n2" user={user} language="ru" subscription={null} onBack={() => undefined} />);
  await screen.findByDisplayValue('Plan');
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('Проект');
  expect(select.selectedOptions[0].textContent).toBe('Проект');
});
