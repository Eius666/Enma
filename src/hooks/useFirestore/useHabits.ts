import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy, addDoc, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { habitsCollection, workspacesCollection } from '../../lib/firestore';
import { db } from '../../src/firebase';
import type { Habit } from '../../types';

export function useHabits(userId: string | null, workspaceId: string | null) {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !workspaceId) {
      setHabits([]);
      setLoading(false);
      return;
    }

    const q = query(
      habitsCollection(userId, workspaceId),
      orderBy('createdAt', 'asc')
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Habit[];
        setHabits(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId, workspaceId]);

  const addHabit = async (habit: Omit<Habit, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const now = Date.now();
    const ref = await addDoc(habitsCollection(userId, workspaceId), {
      ...habit,
      createdAt: now,
      updatedAt: now,
    } as Omit<Habit, 'id'>);
    return ref.id;
  };

  const updateHabit = async (habitId: string, patch: Partial<Omit<Habit, 'id'>>): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'habits', habitId);
    await updateDoc(ref, { ...patch, updatedAt: Date.now() });
  };

  const deleteHabit = async (habitId: string): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'habits', habitId);
    await deleteDoc(ref);
  };

  return { habits, loading, error, addHabit, updateHabit, deleteHabit };
}
