import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NotesTab } from '../tabs/NotesTab';

// BUG-06: a note created while a folder is open belongs to that folder.
// The real notes list with Firestore faked; the editor is a stub that shows
// what it was opened with.

const mockNotes = [
  { id: 'n1', userId: 'u1', title: 'Diary', content: '', type: 'text', checklistItems: [], category: 'Личное', pinned: false },
  { id: 'n2', userId: 'u1', title: 'Plan', content: '', type: 'text', checklistItems: [], category: 'Проект', pinned: false },
];

const mockUpdates: Array<{ path: string; data: Record<string, unknown> }> = [];

jest.mock('../../firebase', () => ({ db: { __db: true }, auth: {} }));
jest.mock('firebase/firestore', () => ({
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  orderBy: () => ({}),
  doc: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  onSnapshot: (_q: unknown, next: (s: unknown) => void) => {
    setTimeout(() => next({ docs: mockNotes.map(n => ({ id: n.id, data: () => n })) }), 0);
    return () => undefined;
  },
  updateDoc: async (ref: { path: string }, data: Record<string, unknown>) => { mockUpdates.push({ path: ref.path, data }); },
  increment: (n: number) => ({ increment: n }),
  deleteDoc: async () => undefined,
  serverTimestamp: () => 'SERVER_TS',
}));
jest.mock('../../lib/noteDrafts', () => ({
  getNoteDraftStore: () => ({ listForUser: async () => [], clear: async () => undefined }),
}));
jest.mock('../NoteEditor', () => ({
  __esModule: true,
  default: (p: { noteId: string | null; initialCategory?: string; onBack: () => void }) => (
    <div data-testid="editor">
      <span data-testid="editor-note">{p.noteId ?? 'new'}</span>
      <span data-testid="editor-folder">{p.initialCategory ?? '(none)'}</span>
      <button type="button" onClick={p.onBack}>back</button>
    </div>
  ),
}));

const user = { uid: 'u1' } as never;

async function renderTab() {
  render(<NotesTab language="ru" user={user} subscription={null} />);
  await act(async () => { await new Promise(r => setTimeout(r, 150)); }); // list subscribes after 100 ms
}
const chip = (name: string) => screen.getByRole('button', { name });
const newNote = () => fireEvent.click(screen.getByRole('button', { name: 'Создать заметку' }));
const editorFolder = () => screen.getByTestId('editor-folder').textContent;
const back = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  await act(async () => { await new Promise(r => setTimeout(r, 150)); });
};

test('inside a folder, a new note is created in that folder', async () => {
  await renderTab();
  fireEvent.click(chip('Личное'));
  newNote();
  expect(screen.getByTestId('editor-note').textContent).toBe('new');
  expect(editorFolder()).toBe('Личное');
});

test('at the top level ("Все"), a new note gets no folder', async () => {
  await renderTab();
  newNote();
  expect(editorFolder()).toBe('(none)');
});

test('any folder works, including one that only exists through its notes', async () => {
  await renderTab();
  fireEvent.click(chip('Проект'));
  newNote();
  expect(editorFolder()).toBe('Проект');
});

test('opening an existing note never hands it the open folder', async () => {
  await renderTab();
  fireEvent.click(chip('Работа'));
  fireEvent.click(chip('Все'));
  fireEvent.click(screen.getByRole('button', { name: /Plan/ }));
  expect(screen.getByTestId('editor-note').textContent).toBe('n2');
  expect(editorFolder()).toBe('(none)');
});

test('coming back from the editor keeps the open folder', async () => {
  await renderTab();
  fireEvent.click(chip('Проект'));
  newNote();
  await back();
  expect(chip('Проект').className).toMatch(/notes-list__chip--active/);
});

test('a folder created in this session keeps receiving new notes before any of its notes exists', async () => {
  await renderTab();
  fireEvent.click(screen.getByTitle('Новая категория'));
  const name = screen.getByPlaceholderText('Название категории');
  fireEvent.change(name, { target: { value: 'Книги' } });
  fireEvent.keyDown(name, { key: 'Enter' });
  newNote();
  expect(editorFolder()).toBe('Книги');
  await back();
  expect(chip('Книги').className).toMatch(/notes-list__chip--active/);
});

test('switching folders between two new notes uses the folder current at each press', async () => {
  await renderTab();
  fireEvent.click(chip('Личное'));
  newNote();
  expect(editorFolder()).toBe('Личное');
  await back();
  fireEvent.click(chip('Идеи'));
  newNote();
  expect(editorFolder()).toBe('Идеи');
});

test('pinning from the list is a full edit: it raises the note revision', async () => {
  mockUpdates.length = 0;
  await renderTab();
  fireEvent.contextMenu(screen.getByText('Plan'));
  fireEvent.click(screen.getByRole('button', { name: /Закрепить/ }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  expect(mockUpdates).toEqual([{ path: 'notes/n2', data: { pinned: true, updatedAt: 'SERVER_TS', rev: { increment: 1 } } }]);
});
