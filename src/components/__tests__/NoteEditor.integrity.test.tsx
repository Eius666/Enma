import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NoteEditor from '../NoteEditor';
import type { NoteDraft } from '../../lib/noteDrafts';

// Integrity of an existing note opened in the editor: nothing is written
// unless the user changed something, a failed load never turns into an empty
// note, and a write never silently replaces a newer version. Firestore is an
// in-memory fake with the same `rev` rule the real transaction applies; the
// network can be switched off; local drafts live in an in-memory store that
// survives between editor openings, as IndexedDB does.

type NoteData = Record<string, unknown>;
const mockServer: Record<string, NoteData> = {};
const mockNet = { online: true, hold: null as null | Promise<void> };
const mockWrites: Array<{ path: string; data: NoteData }> = [];

const offlineError = () => Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });

jest.mock('../../firebase', () => ({ db: { __db: true }, auth: {} }));
jest.mock('../../lib/usageCounters', () => ({ subscribeFreeUsage: () => () => undefined }));
jest.mock('firebase/firestore', () => {
  const snap = (path: string) => {
    const data = mockServer[path] ? { ...mockServer[path] } : undefined;
    return { exists: () => !!data, data: () => data };
  };
  return {
    doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
    getDoc: async (ref: { __path: string }) => {
      if (mockNet.hold) await mockNet.hold;
      if (!mockNet.online) throw offlineError();
      return snap(ref.__path);
    },
    deleteDoc: async () => undefined,
    serverTimestamp: () => ({ seconds: 1_800_000_000 }),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      if (!mockNet.online) throw offlineError();
      const staged: Array<{ path: string; data: NoteData }> = [];
      const result = await fn({
        get: async (ref: { __path: string }) => snap(ref.__path),
        set: (ref: { __path: string }, data: NoteData) => { staged.push({ path: ref.__path, data }); },
      });
      for (const w of staged) {
        mockServer[w.path] = { ...(mockServer[w.path] ?? {}), ...w.data };
        mockWrites.push(w);
      }
      return result;
    },
  };
});

const mockDrafts = new Map<string, NoteDraft>();
jest.mock('../../lib/noteDrafts', () => {
  const actual = jest.requireActual('../../lib/noteDrafts');
  const store = {
    save: async (d: NoteDraft) => { mockDrafts.set(`${d.uid}::${d.noteId}`, { ...d }); return true; },
    load: async (uid: string, id: string) => mockDrafts.get(`${uid}::${id}`) ?? null,
    clear: async (uid: string, id: string) => { mockDrafts.delete(`${uid}::${id}`); },
    listForUser: async () => Array.from(mockDrafts.values()),
  };
  return { ...actual, getNoteDraftStore: () => store };
});

const user = { uid: 'u1', getIdToken: async () => 'token' } as never;
const DEBOUNCE_AND_MORE = 900;
const settle = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

// A note written before `rev` existed, or created by the server
// (api entityCreate, the bot): it has no `rev` field.
const legacyNote = (): NoteData => ({
  id: 'n1', userId: 'u1', title: 'Список покупок', content: 'молоко\nхлеб', type: 'text',
  checklistItems: [], category: 'Личное', pinned: true,
});

beforeEach(() => {
  for (const k of Object.keys(mockServer)) delete mockServer[k];
  mockWrites.length = 0;
  mockDrafts.clear();
  mockNet.online = true;
  mockNet.hold = null;
  global.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
});

function openEditor(noteId = 'n1') {
  const onBack = jest.fn();
  const view = render(<NoteEditor noteId={noteId} user={user} language="ru" subscription={null} onBack={onBack} />);
  return { onBack, unmount: view.unmount };
}

test('opening a note and leaving without changes writes nothing (no revision bump, no draft)', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 3 };
  const { unmount } = openEditor();
  await screen.findByDisplayValue('Список покупок');
  await settle(DEBOUNCE_AND_MORE);
  unmount();
  await settle(50);
  expect(mockWrites).toEqual([]);
  expect(mockServer['notes/n1'].rev).toBe(3);
  expect(mockDrafts.size).toBe(0);
});

test('editing before the note has loaded is not possible, and the loaded text is what gets edited', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 1 };
  let release: () => void = () => undefined;
  mockNet.hold = new Promise<void>(r => { release = r; });
  openEditor();
  await settle(50);
  expect(screen.queryByPlaceholderText('Заголовок')).toBeNull();
  expect(screen.queryByPlaceholderText('Начните писать…')).toBeNull();
  mockNet.hold = null;
  release();
  const content = await screen.findByDisplayValue(/молоко/);
  fireEvent.change(content, { target: { value: 'молоко\nхлеб\nсыр' } });
  await waitFor(() => expect(mockWrites).toHaveLength(1), { timeout: 3000 });
  expect(mockServer['notes/n1']).toMatchObject({ title: 'Список покупок', content: 'молоко\nхлеб\nсыр', category: 'Личное', pinned: true, rev: 2 });
});

test('a note that could not be loaded (offline) is not shown as an empty note and nothing is written', async () => {
  mockServer['notes/n1'] = legacyNote();
  mockNet.online = false;
  openEditor();
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось открыть заметку');
  expect(screen.queryByPlaceholderText('Заголовок')).toBeNull();
  mockNet.online = true;
  await settle(DEBOUNCE_AND_MORE);
  expect(mockWrites).toEqual([]);
  expect(mockDrafts.size).toBe(0);
  expect(mockServer['notes/n1']).toEqual(legacyNote());
});

test('after a failed load, "Повторить" loads the real note once the connection is back', async () => {
  mockServer['notes/n1'] = legacyNote();
  mockNet.online = false;
  openEditor();
  await screen.findByRole('alert');
  mockNet.online = true;
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByDisplayValue('Список покупок')).toBeTruthy();
  await settle(DEBOUNCE_AND_MORE);
  expect(mockWrites).toEqual([]);
});

test('offline → online: opening the note offline and again online keeps its text (old note without rev)', async () => {
  mockServer['notes/n1'] = legacyNote();
  mockNet.online = false;
  const first = openEditor();
  await settle(DEBOUNCE_AND_MORE);
  first.unmount();
  await settle(50);
  mockNet.online = true;
  const second = openEditor();
  await settle(DEBOUNCE_AND_MORE);
  second.unmount();
  await settle(50);
  expect(mockServer['notes/n1']).toMatchObject({ title: 'Список покупок', content: 'молоко\nхлеб', category: 'Личное', pinned: true });
});

test('an empty draft already left on the device is never applied over the note without asking', async () => {
  // What a failed load used to leave behind: empty fields, baseRev 0.
  mockServer['notes/n1'] = legacyNote();
  mockDrafts.set('u1::n1', {
    uid: 'u1', noteId: 'n1', title: '', content: '', type: 'text', checklistItems: [], category: 'Общее', pinned: false,
    baseRev: 0, savedAtLocal: Date.now() - 60_000,
  });
  openEditor();
  expect(await screen.findByText('Конфликт версий')).toBeTruthy();
  await settle(DEBOUNCE_AND_MORE);
  expect(mockWrites).toEqual([]);
  expect(mockServer['notes/n1']).toEqual(legacyNote());
  fireEvent.click(screen.getByRole('button', { name: 'Использовать их версию' }));
  expect(await screen.findByDisplayValue('Список покупок')).toBeTruthy();
  await settle(DEBOUNCE_AND_MORE);
  expect(mockServer['notes/n1']).toMatchObject({ title: 'Список покупок', content: 'молоко\nхлеб' });
});

test('unsaved edits made offline are restored and saved when the note is opened online', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 2 };
  const first = openEditor();
  const content = await screen.findByDisplayValue(/молоко/);
  mockNet.online = false;
  fireEvent.change(content, { target: { value: 'молоко\nхлеб\nяйца' } });
  await settle(DEBOUNCE_AND_MORE);
  first.unmount();
  await settle(50);
  expect(mockServer['notes/n1'].content).toBe('молоко\nхлеб');
  mockNet.online = true;
  openEditor();
  expect(await screen.findByDisplayValue(/яйца/)).toBeTruthy();
  await waitFor(() => expect(mockServer['notes/n1'].content).toBe('молоко\nхлеб\nяйца'), { timeout: 3000 });
  expect(mockServer['notes/n1'].rev).toBe(3);
});

test('a local draft older than the server version is not applied silently (cache vs Firestore conflict)', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), content: 'версия с телефона', rev: 5 };
  mockDrafts.set('u1::n1', {
    uid: 'u1', noteId: 'n1', title: 'Список покупок', content: 'версия с ноутбука', type: 'text', checklistItems: [],
    category: 'Личное', pinned: true, baseRev: 4, savedAtLocal: Date.now() - 60_000,
  });
  openEditor();
  expect(await screen.findByText('Конфликт версий')).toBeTruthy();
  await settle(DEBOUNCE_AND_MORE);
  expect(mockWrites).toEqual([]);
  expect(mockServer['notes/n1'].content).toBe('версия с телефона');
});

test('moving a note to another folder changes only its folder', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 1 };
  const { onBack } = openEditor();
  await screen.findByDisplayValue('Список покупок');
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Работа' } });
  fireEvent.click(screen.getByRole('button', { name: /Заметки/ }));
  await waitFor(() => expect(onBack).toHaveBeenCalled(), { timeout: 3000 });
  expect(mockWrites).toHaveLength(1);
  expect(mockServer['notes/n1']).toMatchObject({ ...legacyNote(), category: 'Работа', rev: 2 });
});

test('two open editors (two devices): merely opening on one never causes a conflict on the other', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 3 };
  const a = openEditor();
  await screen.findByDisplayValue('Список покупок');
  const b = openEditor();
  await settle(DEBOUNCE_AND_MORE);
  expect(screen.queryByText('Конфликт версий')).toBeNull();
  expect(mockServer['notes/n1'].rev).toBe(3);
  a.unmount();
  b.unmount();
});

test('concurrent edits of one note on two devices: the second write asks instead of overwriting', async () => {
  mockServer['notes/n1'] = { ...legacyNote(), rev: 3 };
  const a = openEditor();
  const aContent = await screen.findByDisplayValue(/молоко/);
  const b = openEditor();
  await settle(50);
  fireEvent.change(aContent, { target: { value: 'правка A' } });
  await waitFor(() => expect(mockServer['notes/n1'].content).toBe('правка A'), { timeout: 3000 });
  a.unmount();
  fireEvent.change(await screen.findByDisplayValue(/молоко/), { target: { value: 'правка B' } });
  expect(await screen.findByText('Конфликт версий', {}, { timeout: 3000 })).toBeTruthy();
  expect(mockServer['notes/n1'].content).toBe('правка A');
  b.unmount();
});

test('concurrent edits of an old note without rev are caught as well', async () => {
  mockServer['notes/n1'] = legacyNote();
  const a = openEditor();
  const aContent = await screen.findByDisplayValue(/молоко/);
  const b = openEditor();
  await settle(50);
  fireEvent.change(aContent, { target: { value: 'правка A' } });
  await waitFor(() => expect(mockServer['notes/n1'].content).toBe('правка A'), { timeout: 3000 });
  a.unmount();
  fireEvent.change(await screen.findByDisplayValue(/молоко/), { target: { value: 'правка B' } });
  expect(await screen.findByText('Конфликт версий', {}, { timeout: 3000 })).toBeTruthy();
  expect(mockServer['notes/n1'].content).toBe('правка A');
  b.unmount();
});
