import type {
  CalendarTask, NoteBlock, NotePage, NoteProject, Category, Habit, Reminder, Language,
  AppUserProfile as UserProfile, Transaction as AnyTransaction,
} from '../types/app';
import { STORAGE_KEYS } from '../constants';
import { getDefaultCategories, getDefaultNoteProjects } from './appDefaults';
import { loadProfile } from './profileStore';
import { safeReadJson } from './safeStorage';

// What the app shows instantly on launch, before Firestore answers: the
// per-user copy kept in localStorage under `enma.<uid>.<key>`. Firestore stays
// the source of truth (its first snapshot replaces transactions etc.).

export type UserLocalCache<T = AnyTransaction> = {
  tasks: CalendarTask[];
  noteProjects: NoteProject[];
  notes: NotePage[];
  categories: Category[];
  transactions: T[];
  habits: Habit[];
  reminders: Reminder[];
  profile: UserProfile | null;
};

const readList = <T,>(uid: string, key: string, fallback: T[]): T[] => {
  const value = safeReadJson<unknown>(`enma.${uid}.${key}`, fallback);
  // A corrupted entry (e.g. the string "null" or an object) must not crash the app.
  return Array.isArray(value) ? (value as T[]) : fallback;
};

/** Gives every stored note a type, a project and well-formed blocks. */
export function normalizeStoredNotes(stored: NotePage[], defaultProjectId: string): NotePage[] {
  return stored.map(note => {
    const blocks = Array.isArray(note.blocks) ? note.blocks : [];
    const inferredType =
      note.noteType ?? (blocks.some(block => block.type === 'todo') ? 'checklist' : 'text');
    const normalizedBlocks: NoteBlock[] = blocks.map(block =>
      inferredType === 'checklist'
        ? { id: block.id, content: block.content, type: 'todo', checked: Boolean(block.checked) }
        : { id: block.id, content: block.content, type: 'paragraph' }
    );
    return {
      ...note,
      noteType: inferredType,
      projectId: note.projectId ?? defaultProjectId,
      blocks: normalizedBlocks,
    };
  });
}

export function readUserLocalCache<T = AnyTransaction>(uid: string, language: Language): UserLocalCache<T> {
  const storedProjects = readList<NoteProject>(uid, STORAGE_KEYS.noteProjects, getDefaultNoteProjects(language));
  const noteProjects = storedProjects.length ? storedProjects : getDefaultNoteProjects(language);
  const defaultProjectId = noteProjects[0]?.id ?? 'project-default';
  const storedCategories = readList<Category>(uid, STORAGE_KEYS.categories, []);
  return {
    tasks: readList<CalendarTask>(uid, STORAGE_KEYS.tasks, []),
    noteProjects,
    notes: normalizeStoredNotes(readList<NotePage>(uid, STORAGE_KEYS.notes, []), defaultProjectId),
    categories: storedCategories.length ? storedCategories : getDefaultCategories(language),
    transactions: readList<T>(uid, STORAGE_KEYS.transactions, []),
    habits: readList<Habit>(uid, STORAGE_KEYS.habits, []),
    reminders: readList<Reminder>(uid, STORAGE_KEYS.reminders, []),
    profile: loadProfile(uid),
  };
}
