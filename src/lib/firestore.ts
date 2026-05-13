import { collection, doc, CollectionReference, DocumentReference } from 'firebase/firestore';
import { db } from '../firebase';
import type { UserProfile, Workspace, FinanceTransaction, Habit, HabitLog, Note, Goal } from '../types';

// Typed collection references — workspace-nested data model:
// users/{uid}/workspaces/{wid}/transactions | habits | habitLogs | notes | goals

export function usersCollection(): CollectionReference<UserProfile> {
  return collection(db, 'users') as CollectionReference<UserProfile>;
}

export function userDoc(userId: string): DocumentReference<UserProfile> {
  return doc(db, 'users', userId) as DocumentReference<UserProfile>;
}

export function workspacesCollection(userId: string): CollectionReference<Workspace> {
  return collection(db, 'users', userId, 'workspaces') as CollectionReference<Workspace>;
}

export function workspaceDoc(userId: string, workspaceId: string): DocumentReference<Workspace> {
  return doc(db, 'users', userId, 'workspaces', workspaceId) as DocumentReference<Workspace>;
}

export function transactionsCollection(
  userId: string,
  workspaceId: string
): CollectionReference<FinanceTransaction> {
  return collection(
    db,
    'users', userId, 'workspaces', workspaceId, 'transactions'
  ) as CollectionReference<FinanceTransaction>;
}

export function habitsCollection(
  userId: string,
  workspaceId: string
): CollectionReference<Habit> {
  return collection(
    db,
    'users', userId, 'workspaces', workspaceId, 'habits'
  ) as CollectionReference<Habit>;
}

export function habitLogsCollection(
  userId: string,
  workspaceId: string
): CollectionReference<HabitLog> {
  return collection(
    db,
    'users', userId, 'workspaces', workspaceId, 'habitLogs'
  ) as CollectionReference<HabitLog>;
}

export function notesCollection(
  userId: string,
  workspaceId: string
): CollectionReference<Note> {
  return collection(
    db,
    'users', userId, 'workspaces', workspaceId, 'notes'
  ) as CollectionReference<Note>;
}

export function goalsCollection(
  userId: string,
  workspaceId: string
): CollectionReference<Goal> {
  return collection(
    db,
    'users', userId, 'workspaces', workspaceId, 'goals'
  ) as CollectionReference<Goal>;
}
