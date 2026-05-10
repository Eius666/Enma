import { deleteDoc, doc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';
import { buildTelegramReminderText, getReminderScheduledDate } from './reminderHelpers';
import type { CalendarTask, Category, Habit, Language, NotePage, NoteProject, Reminder, Transaction } from '../types';

export const persistTransaction = async (userId: string, transaction: Transaction): Promise<void> => {
  try {
    await setDoc(
      doc(db, 'transactions', transaction.id),
      { ...transaction, userId, updatedAt: serverTimestamp() },
      { merge: true }
    );
  } catch (error) {
    console.warn('Failed to sync transaction', error);
  }
};

export const deleteTransaction = async (id: string): Promise<void> => {
  try {
    await deleteDoc(doc(db, 'transactions', id));
  } catch (error) {
    console.warn('Failed to delete transaction from Firestore', error);
  }
};

export const persistReminder = async (
  userId: string,
  chatId: number,
  reminder: Reminder,
  language: Language,
  options?: { isNew?: boolean; status?: 'pending' | 'done' }
): Promise<void> => {
  const scheduledAt = getReminderScheduledDate(reminder);
  const status = options?.status ?? (reminder.done ? 'done' : 'pending');
  const payload = {
    id: reminder.id,
    userId,
    chatId,
    title: reminder.title,
    notes: reminder.notes ?? null,
    date: reminder.date,
    time: reminder.time,
    scheduledAt: Timestamp.fromDate(scheduledAt),
    status,
    done: reminder.done,
    language,
    telegramText: buildTelegramReminderText(reminder, language),
    updatedAt: serverTimestamp(),
    ...(options?.isNew ? { createdAt: serverTimestamp() } : {})
  };
  try {
    await setDoc(doc(db, 'reminders', reminder.id), payload, { merge: true });
  } catch (error) {
    console.warn('Failed to sync reminder', error);
  }
};

export const deleteReminder = async (id: string): Promise<void> => {
  try {
    await deleteDoc(doc(db, 'reminders', id));
  } catch (error) {
    console.warn('Failed to delete reminder from Firestore', error);
  }
};

// ── Subcollections: users/{uid}/tasks | notes | noteProjects | habits ──────────

const sub = (userId: string, col: string, id: string) =>
  doc(db, 'users', userId, col, id);

export const persistTask = async (userId: string, task: CalendarTask): Promise<void> => {
  try {
    await setDoc(sub(userId, 'tasks', task.id), { ...task, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    console.warn('Failed to sync task', error);
  }
};

export const deleteTask = async (userId: string, taskId: string): Promise<void> => {
  try {
    await deleteDoc(sub(userId, 'tasks', taskId));
  } catch (error) {
    console.warn('Failed to delete task', error);
  }
};

export const persistNote = async (userId: string, note: NotePage): Promise<void> => {
  try {
    await setDoc(sub(userId, 'notes', note.id), { ...note, updatedAt: note.updatedAt, firestoreUpdatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    console.warn('Failed to sync note', error);
  }
};

export const deleteNote = async (userId: string, noteId: string): Promise<void> => {
  try {
    await deleteDoc(sub(userId, 'notes', noteId));
  } catch (error) {
    console.warn('Failed to delete note', error);
  }
};

export const persistNoteProject = async (userId: string, project: NoteProject): Promise<void> => {
  try {
    await setDoc(sub(userId, 'noteProjects', project.id), { ...project, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    console.warn('Failed to sync note project', error);
  }
};

export const deleteNoteProject = async (userId: string, projectId: string): Promise<void> => {
  try {
    await deleteDoc(sub(userId, 'noteProjects', projectId));
  } catch (error) {
    console.warn('Failed to delete note project', error);
  }
};

export const persistHabit = async (userId: string, habit: Habit): Promise<void> => {
  try {
    await setDoc(sub(userId, 'habits', habit.id), { ...habit, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    console.warn('Failed to sync habit', error);
  }
};

export const deleteHabit = async (userId: string, habitId: string): Promise<void> => {
  try {
    await deleteDoc(sub(userId, 'habits', habitId));
  } catch (error) {
    console.warn('Failed to delete habit', error);
  }
};

// Embeds categories in the user doc so the Telegram webhook can read them
export const syncCategories = async (userId: string, categories: Category[]): Promise<void> => {
  try {
    await setDoc(
      doc(db, 'users', userId),
      { categories, categoriesUpdatedAt: serverTimestamp() },
      { merge: true }
    );
  } catch (error) {
    console.warn('Failed to sync categories', error);
  }
};
