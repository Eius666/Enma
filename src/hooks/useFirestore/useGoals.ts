import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy, addDoc, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { goalsCollection } from '../../lib/firestore';
import { db } from '../../src/firebase';
import type { Goal } from '../../types';

export function useGoals(userId: string | null, workspaceId: string | null) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !workspaceId) {
      setGoals([]);
      setLoading(false);
      return;
    }

    const q = query(
      goalsCollection(userId, workspaceId),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Goal[];
        setGoals(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId, workspaceId]);

  const addGoal = async (goal: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const now = Date.now();
    const ref = await addDoc(goalsCollection(userId, workspaceId), {
      ...goal,
      createdAt: now,
      updatedAt: now,
    } as Omit<Goal, 'id'>);
    return ref.id;
  };

  const updateGoal = async (goalId: string, patch: Partial<Omit<Goal, 'id'>>): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'goals', goalId);
    await updateDoc(ref, { ...patch, updatedAt: Date.now() });
  };

  const deleteGoal = async (goalId: string): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'goals', goalId);
    await deleteDoc(ref);
  };

  return { goals, loading, error, addGoal, updateGoal, deleteGoal };
}
