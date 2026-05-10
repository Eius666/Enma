import { useCallback, useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from '../lib/firebase';
import {
  createId,
  getDefaultCategories,
  getDefaultNoteProjects,
  loadProfile,
  saveProfile,
  STORAGE_KEYS,
  storageKey
} from '../lib/utils';
import {
  deleteReminder as deleteReminderFS,
  persistReminder as persistReminderFS,
  persistTransaction as persistTransactionFS,
  deleteTransaction as deleteTransactionFS,
  persistTask as persistTaskFS,
  deleteTask as deleteTaskFS,
  persistNote as persistNoteFS,
  deleteNote as deleteNoteFS,
  persistNoteProject as persistNoteProjectFS,
  deleteNoteProject as deleteNoteProjectFS,
  persistHabit as persistHabitFS,
  deleteHabit as deleteHabitFS,
  syncCategories as syncCategoriesFS
} from '../lib/firestoreOps';
import {
  ENABLE_CLIENT_REMINDERS,
  getReminderScheduledDate,
  notifyTelegramReminder
} from '../lib/reminderHelpers';
import type {
  CalendarTask,
  Category,
  Habit,
  Language,
  NoteBlock,
  NotePage,
  NoteProject,
  Reminder,
  Transaction,
  UserProfile
} from '../types';
import type { TelegramWebApp } from '../telegram';

export const useUserData = (
  user: User | null,
  telegram: TelegramWebApp | null,
  language: Language
) => {
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [notes, setNotes] = useState<NotePage[]>([]);
  const [noteProjects, setNoteProjects] = useState<NoteProject[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const prevUserId = useRef<string | null>(null);
  const transactionsBackfillRef = useRef(false);
  const remindersBackfillRef = useRef(false);

  // Tracks which collections were just updated by Firestore (to skip write-back)
  const fromFirestoreRef = useRef<Set<string>>(new Set());
  // Previous snapshots for diffing (only write changed docs to Firestore)
  const prevTasksRef = useRef<CalendarTask[]>([]);
  const prevNotesRef = useRef<NotePage[]>([]);
  const prevNoteProjectsRef = useRef<NoteProject[]>([]);
  const prevHabitsRef = useRef<Habit[]>([]);

  // Load all data from localStorage when user changes
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
    if (prevUserId.current === user.uid) return;
    prevUserId.current = user.uid;

    const read = <T,>(key: string, fallback: T): T => {
      try {
        const raw = localStorage.getItem(storageKey(user.uid, key));
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    setTasks(read<CalendarTask[]>(STORAGE_KEYS.tasks, []));

    const storedProjects = read<NoteProject[]>(STORAGE_KEYS.noteProjects, getDefaultNoteProjects(language));
    const normalizedProjects = storedProjects.length ? storedProjects : getDefaultNoteProjects(language);
    setNoteProjects(normalizedProjects);

    const defaultProjectId = normalizedProjects[0]?.id ?? 'project-default';
    const storedNotes = read<NotePage[]>(STORAGE_KEYS.notes, []);
    setNotes(
      storedNotes.map(note => {
        const inferredType =
          note.noteType ?? (note.blocks.some(b => b.type === 'todo') ? 'checklist' : 'text');
        const normalizedBlocks: NoteBlock[] = note.blocks.map(block =>
          inferredType === 'checklist'
            ? { id: block.id, content: block.content, type: 'todo', checked: Boolean(block.checked) }
            : { id: block.id, content: block.content, type: 'paragraph' }
        );
        return {
          ...note,
          noteType: inferredType,
          projectId: note.projectId ?? defaultProjectId,
          blocks: normalizedBlocks
        };
      })
    );

    const storedCategories = read<Category[]>(STORAGE_KEYS.categories, []);
    setCategories(storedCategories.length ? storedCategories : getDefaultCategories(language));
    setTransactions(read<Transaction[]>(STORAGE_KEYS.transactions, []));
    setHabits(read<Habit[]>(STORAGE_KEYS.habits, []));
    setReminders(read<Reminder[]>(STORAGE_KEYS.reminders, []));
    setProfile(loadProfile(user.uid));
  }, [user, language]);

  // Auto-set display name from Telegram if not set
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user) return;
    if (profile?.displayName) return;
    const tgUser = telegram.initDataUnsafe.user;
    const tgName =
      [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') ||
      tgUser.username ||
      'Friend';
    const nextProfile: UserProfile = { displayName: tgName };
    setProfile(nextProfile);
    saveProfile(user.uid, nextProfile);
  }, [telegram, user, profile]);

  // localStorage + Firestore write-through persistence
  // Guard: if this collection was just updated BY Firestore, skip the write-back.
  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.tasks), JSON.stringify(tasks));
    if (fromFirestoreRef.current.has('tasks')) { fromFirestoreRef.current.delete('tasks'); return; }
    const prev = prevTasksRef.current;
    prevTasksRef.current = tasks;
    const prevMap = new Map(prev.map(t => [t.id, t]));
    const currIds = new Set(tasks.map(t => t.id));
    tasks
      .filter(t => !prevMap.has(t.id) || JSON.stringify(prevMap.get(t.id)) !== JSON.stringify(t))
      .forEach(t => persistTaskFS(user.uid, t));
    prev.filter(t => !currIds.has(t.id)).forEach(t => deleteTaskFS(user.uid, t.id));
  }, [user, tasks]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.notes), JSON.stringify(notes));
    if (fromFirestoreRef.current.has('notes')) { fromFirestoreRef.current.delete('notes'); return; }
    const prev = prevNotesRef.current;
    prevNotesRef.current = notes;
    const prevMap = new Map(prev.map(n => [n.id, n]));
    const currIds = new Set(notes.map(n => n.id));
    notes
      .filter(n => !prevMap.has(n.id) || JSON.stringify(prevMap.get(n.id)) !== JSON.stringify(n))
      .forEach(n => persistNoteFS(user.uid, n));
    prev.filter(n => !currIds.has(n.id)).forEach(n => deleteNoteFS(user.uid, n.id));
  }, [user, notes]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.noteProjects), JSON.stringify(noteProjects));
    if (fromFirestoreRef.current.has('noteProjects')) { fromFirestoreRef.current.delete('noteProjects'); return; }
    const prev = prevNoteProjectsRef.current;
    prevNoteProjectsRef.current = noteProjects;
    const prevMap = new Map(prev.map(p => [p.id, p]));
    const currIds = new Set(noteProjects.map(p => p.id));
    noteProjects
      .filter(p => !prevMap.has(p.id) || JSON.stringify(prevMap.get(p.id)) !== JSON.stringify(p))
      .forEach(p => persistNoteProjectFS(user.uid, p));
    prev.filter(p => !currIds.has(p.id)).forEach(p => deleteNoteProjectFS(user.uid, p.id));
  }, [user, noteProjects]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.categories), JSON.stringify(categories));
    if (fromFirestoreRef.current.has('categories')) { fromFirestoreRef.current.delete('categories'); return; }
    syncCategoriesFS(user.uid, categories);
  }, [user, categories]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.transactions), JSON.stringify(transactions));
  }, [user, transactions]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.habits), JSON.stringify(habits));
    if (fromFirestoreRef.current.has('habits')) { fromFirestoreRef.current.delete('habits'); return; }
    const prev = prevHabitsRef.current;
    prevHabitsRef.current = habits;
    const prevMap = new Map(prev.map(h => [h.id, h]));
    const currIds = new Set(habits.map(h => h.id));
    habits
      .filter(h => !prevMap.has(h.id) || JSON.stringify(prevMap.get(h.id)) !== JSON.stringify(h))
      .forEach(h => persistHabitFS(user.uid, h));
    prev.filter(h => !currIds.has(h.id)).forEach(h => deleteHabitFS(user.uid, h.id));
  }, [user, habits]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.reminders), JSON.stringify(reminders));
  }, [user, reminders]);

  // Firestore: real-time transactions subscription
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'transactions'), where('userId', '==', user.uid));
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites) return;
        const cloud = snapshot.docs
          .map(d => ({ id: d.id, ...d.data() } as Transaction))
          .sort((a, b) => b.date.localeCompare(a.date));
        setTransactions(prev => {
          const cloudIds = new Set(cloud.map(tx => tx.id));
          const localOnly = prev.filter(tx => !cloudIds.has(tx.id));
          return [...cloud, ...localOnly].sort((a, b) => b.date.localeCompare(a.date));
        });
      },
      err => console.warn('Failed to subscribe to transactions', err)
    );
  }, [user]);

  // Firestore: real-time reminders subscription
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'reminders'), where('userId', '==', user.uid));
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites) return;
        const cloud = snapshot.docs.map(d => {
          const data = d.data();
          return {
            id: d.id,
            title: data.title as string,
            date: data.date as string,
            time: data.time as string,
            notes: data.notes ?? undefined,
            done: data.done ?? false,
            notified: data.status === 'sent'
          } as Reminder;
        });
        fromFirestoreRef.current.add('reminders');
        setReminders(prev => {
          const cloudIds = new Set(cloud.map(r => r.id));
          const localOnly = prev.filter(r => !cloudIds.has(r.id));
          return [...cloud, ...localOnly].sort((a, b) => a.date.localeCompare(b.date));
        });
      },
      err => console.warn('Failed to subscribe to reminders', err)
    );
  }, [user]);

  // Firestore: real-time tasks subscription (subcollection)
  useEffect(() => {
    if (!user) return;
    const q = collection(db, 'users', user.uid, 'tasks');
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.empty) return;
        const cloud = snapshot.docs.map(d => d.data() as CalendarTask);
        fromFirestoreRef.current.add('tasks');
        setTasks(prev => {
          const cloudIds = new Set(cloud.map(t => t.id));
          const localOnly = prev.filter(t => !cloudIds.has(t.id));
          return [...cloud, ...localOnly].sort((a, b) => a.date.localeCompare(b.date));
        });
      },
      err => console.warn('Failed to subscribe to tasks', err)
    );
  }, [user]);

  // Firestore: real-time notes subscription (subcollection)
  useEffect(() => {
    if (!user) return;
    const q = collection(db, 'users', user.uid, 'notes');
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.empty) return;
        const cloud = snapshot.docs.map(d => d.data() as NotePage);
        fromFirestoreRef.current.add('notes');
        setNotes(prev => {
          const cloudIds = new Set(cloud.map(n => n.id));
          const localOnly = prev.filter(n => !cloudIds.has(n.id));
          return [...cloud, ...localOnly].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
      },
      err => console.warn('Failed to subscribe to notes', err)
    );
  }, [user]);

  // Firestore: real-time noteProjects subscription (subcollection)
  useEffect(() => {
    if (!user) return;
    const q = collection(db, 'users', user.uid, 'noteProjects');
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.empty) return;
        const cloud = snapshot.docs.map(d => d.data() as NoteProject);
        fromFirestoreRef.current.add('noteProjects');
        setNoteProjects(prev => {
          const cloudIds = new Set(cloud.map(p => p.id));
          const localOnly = prev.filter(p => !cloudIds.has(p.id));
          return [...cloud, ...localOnly];
        });
      },
      err => console.warn('Failed to subscribe to noteProjects', err)
    );
  }, [user]);

  // Firestore: real-time habits subscription (subcollection)
  useEffect(() => {
    if (!user) return;
    const q = collection(db, 'users', user.uid, 'habits');
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.empty) return;
        const cloud = snapshot.docs.map(d => d.data() as Habit);
        fromFirestoreRef.current.add('habits');
        setHabits(prev => {
          const cloudIds = new Set(cloud.map(h => h.id));
          const localOnly = prev.filter(h => !cloudIds.has(h.id));
          return [...cloud, ...localOnly];
        });
      },
      err => console.warn('Failed to subscribe to habits', err)
    );
  }, [user]);

  // Backfill local transactions to Firestore on first load
  useEffect(() => {
    if (!user || transactionsBackfillRef.current) return;
    if (transactions.length === 0) { transactionsBackfillRef.current = true; return; }
    transactionsBackfillRef.current = true;
    transactions.forEach(tx => persistTransactionFS(user.uid, tx));
  }, [transactions, user]);

  // Backfill local reminders to Firestore on first load
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id || remindersBackfillRef.current) return;
    if (reminders.length === 0) { remindersBackfillRef.current = true; return; }
    remindersBackfillRef.current = true;
    const chatId = telegram.initDataUnsafe.user.id;
    reminders.forEach(r =>
      persistReminderFS(user.uid, chatId, r, language, {
        isNew: true,
        status: r.done ? 'done' : 'pending'
      })
    );
  }, [reminders, telegram, user, language]);

  // Client-side reminder polling (only when REACT_APP_CLIENT_REMINDERS=true)
  useEffect(() => {
    if (!ENABLE_CLIENT_REMINDERS) return;
    if (!telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    const interval = setInterval(() => {
      setReminders(prev => {
        let changed = false;
        const updated = prev.map(r => {
          if (r.done || r.notified) return r;
          if (getReminderScheduledDate(r) <= new Date()) {
            notifyTelegramReminder(chatId, r, language);
            changed = true;
            return { ...r, notified: true };
          }
          return r;
        });
        return changed ? updated : prev;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [telegram, language]);

  // Habit actions
  const addHabit = useCallback((title: string) => {
    if (!title.trim()) return;
    const newHabit: Habit = { id: createId(), title: title.trim(), history: {} };
    setHabits(prev => [...prev, newHabit]);
  }, []);

  const toggleHabitDay = useCallback((habitId: string, dateKey: string) => {
    setHabits(prev =>
      prev.map(h =>
        h.id === habitId
          ? { ...h, history: { ...h.history, [dateKey]: !h.history[dateKey] } }
          : h
      )
    );
  }, []);

  const deleteHabit = useCallback((habitId: string) => {
    setHabits(prev => prev.filter(h => h.id !== habitId));
  }, []);

  // Reminder actions
  const addReminder = useCallback(
    (date: Date, title: string, time: string, notes?: string) => {
      if (!title.trim()) return;
      const reminder: Reminder = {
        id: createId(),
        title: title.trim(),
        date: date.toISOString(),
        time,
        notes: notes?.trim() || undefined,
        done: false,
        notified: false
      };
      setReminders(prev => [...prev, reminder]);
      if (user && telegram?.initDataUnsafe?.user?.id) {
        persistReminderFS(user.uid, telegram.initDataUnsafe.user.id, reminder, language, {
          isNew: true,
          status: 'pending'
        });
      }
    },
    [user, telegram, language]
  );

  const toggleReminder = useCallback(
    (id: string) => {
      setReminders(prev =>
        prev.map(r => {
          if (r.id !== id) return r;
          const next = { ...r, done: !r.done, notified: r.done ? false : r.notified };
          if (user && telegram?.initDataUnsafe?.user?.id) {
            persistReminderFS(user.uid, telegram.initDataUnsafe.user.id, next, language);
          }
          return next;
        })
      );
    },
    [user, telegram, language]
  );

  const deleteReminder = useCallback(
    (id: string) => {
      setReminders(prev => prev.filter(r => r.id !== id));
      deleteReminderFS(id);
    },
    []
  );

  return {
    tasks,
    notes,
    noteProjects,
    categories,
    transactions,
    habits,
    reminders,
    profile,
    setTasks,
    setNotes,
    setNoteProjects,
    setCategories,
    setTransactions,
    addHabit,
    toggleHabitDay,
    deleteHabit,
    addReminder,
    toggleReminder,
    deleteReminder,
    persistTransactionToFirestore: (tx: Transaction) =>
      user ? persistTransactionFS(user.uid, tx) : Promise.resolve(),
    deleteTransactionFromFirestore: (id: string) => deleteTransactionFS(id)
  };
};
