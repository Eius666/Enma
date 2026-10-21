import { readUserLocalCache, normalizeStoredNotes } from '../userCache';
import type { NotePage } from '../../types/app';

const put = (uid: string, key: string, value: unknown) =>
  localStorage.setItem(`enma.${uid}.${key}`, typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => localStorage.clear());

test('empty storage yields empty lists and the language-specific defaults', () => {
  const en = readUserLocalCache('u1', 'en');
  expect(en).toMatchObject({ tasks: [], notes: [], transactions: [], habits: [], reminders: [], profile: null });
  expect(en.noteProjects).toEqual([{ id: 'project-default', name: 'General' }]);
  expect(en.categories.map(c => c.name)).toContain('Salary');
  const ru = readUserLocalCache('u1', 'ru');
  expect(ru.noteProjects[0].name).toBe('Общее');
  expect(ru.categories.map(c => c.name)).toContain('Зарплата');
});

test('reads the existing keys/formats written by earlier versions', () => {
  put('u1', 'tasks', [{ id: 't', title: 'x', date: '2026-01-01', color: '#fff' }]);
  put('u1', 'finance.transactions', [{ id: 'a', type: 'expense', amount: 5 }]);
  put('u1', 'habits', [{ id: 'h', title: 'h', history: {} }]);
  put('u1', 'reminders', [{ id: 'r', title: 'r', date: '2026-01-01', time: '10:00', done: false }]);
  put('u1', 'finance.categories', [{ id: 'c', name: 'Mine', type: 'expense' }]);
  put('u1', 'notes.projects', [{ id: 'p1', name: 'Work' }]);
  put('u1', 'profile', { displayName: 'Anna' });
  const c = readUserLocalCache('u1', 'en');
  expect(c.tasks).toHaveLength(1);
  expect(c.transactions[0]).toMatchObject({ id: 'a' });
  expect(c.habits).toHaveLength(1);
  expect(c.reminders).toHaveLength(1);
  expect(c.categories).toEqual([{ id: 'c', name: 'Mine', type: 'expense' }]);
  expect(c.noteProjects).toEqual([{ id: 'p1', name: 'Work' }]);
  expect(c.profile).toEqual({ displayName: 'Anna' });
});

test('other users are never read', () => {
  put('u2', 'tasks', [{ id: 'theirs' }]);
  expect(readUserLocalCache('u1', 'en').tasks).toEqual([]);
});

test('corrupted entries (invalid JSON, "null", wrong shape) fall back instead of crashing, and are not deleted', () => {
  put('u1', 'tasks', '{broken');
  put('u1', 'notes', 'null');
  put('u1', 'finance.transactions', '{"not":"a list"}');
  put('u1', 'habits', '42');
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const c = readUserLocalCache('u1', 'en');
  expect(c.tasks).toEqual([]);
  expect(c.notes).toEqual([]);
  expect(c.transactions).toEqual([]);
  expect(c.habits).toEqual([]);
  expect(localStorage.getItem('enma.u1.tasks')).toBe('{broken');
  expect(localStorage.getItem('enma.u1.notes')).toBe('null');
});

test('stored notes are normalised: inferred type, default project, well-formed blocks', () => {
  const notes = [
    { id: 'n1', title: 'a', updatedAt: 'x', blocks: [{ id: 'b', type: 'todo', content: 'c', checked: 1 }] },
    { id: 'n2', title: 'b', updatedAt: 'x', noteType: 'text', projectId: 'p9', blocks: [{ id: 'b', type: 'todo', content: 'c', checked: true }] },
    { id: 'n3', title: 'c', updatedAt: 'x' },
  ] as unknown as NotePage[];
  const out = normalizeStoredNotes(notes, 'project-default');
  expect(out[0]).toMatchObject({ noteType: 'checklist', projectId: 'project-default' });
  expect(out[0].blocks[0]).toEqual({ id: 'b', content: 'c', type: 'todo', checked: true });
  expect(out[1]).toMatchObject({ noteType: 'text', projectId: 'p9' });
  expect(out[1].blocks[0]).toEqual({ id: 'b', content: 'c', type: 'paragraph' });
  expect(out[2].blocks).toEqual([]);
});

test('works when localStorage throws', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(readUserLocalCache('u1', 'en').notes).toEqual([]);
  jest.restoreAllMocks();
});
