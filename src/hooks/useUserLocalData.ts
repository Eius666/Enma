import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { User } from 'firebase/auth';
import { STORAGE_KEYS } from '../constants';
import { readUserLocalCache } from '../lib/userCache';
import { usePersistedCache } from './usePersistedCache';
import type {
  CalendarTask, NotePage, NoteProject, Category, Habit, AppUserProfile, Reminder, Language,
} from '../types/app';

// The per-user data the shell keeps in memory and mirrors to localStorage
// (moved out of App.tsx unchanged): cleared on sign-out, hydrated from the
// local cache once per signed-in uid, persisted back on every change.
// Firestore listeners (transactions, reminders) write into the same state.
// The reminders list itself is owned by the shell (its reminder code lives
// there) and handed in.
export function useUserLocalData<TTransaction>(
  user: User | null,
  language: Language,
  reminders: Reminder[],
  setReminders: Dispatch<SetStateAction<Reminder[]>>
) {
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [notes, setNotes] = useState<NotePage[]>([]);
  const [noteProjects, setNoteProjects] = useState<NoteProject[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<TTransaction[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [profile, setProfile] = useState<AppUserProfile | null>(null);
  const prevUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      setTasks([]);
      setNotes([]);
      setNoteProjects([]);
      setCategories([]);
      setTransactions([]);
      setHabits([]);
      setReminders([]);
      setProfile(null);
      prevUserId.current = null;
      return;
    }

    if (prevUserId.current === user.uid) {
      return;
    }
    prevUserId.current = user.uid;

    const cache = readUserLocalCache<TTransaction>(user.uid, language);
    setTasks(cache.tasks);
    setNoteProjects(cache.noteProjects);
    setNotes(cache.notes);
    setCategories(cache.categories);
    setTransactions(cache.transactions);
    setHabits(cache.habits);
    setReminders(cache.reminders);
    setProfile(cache.profile);
  }, [user, language, setReminders]);

  usePersistedCache(user?.uid, STORAGE_KEYS.tasks, tasks);
  usePersistedCache(user?.uid, STORAGE_KEYS.notes, notes);
  usePersistedCache(user?.uid, STORAGE_KEYS.noteProjects, noteProjects);
  usePersistedCache(user?.uid, STORAGE_KEYS.categories, categories);
  usePersistedCache(user?.uid, STORAGE_KEYS.transactions, transactions);
  usePersistedCache(user?.uid, STORAGE_KEYS.habits, habits);
  usePersistedCache(user?.uid, STORAGE_KEYS.reminders, reminders);

  return {
    notes, categories,
    transactions, setTransactions,
    profile, setProfile,
  };
}
