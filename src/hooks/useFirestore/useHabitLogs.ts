import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy, addDoc, where } from 'firebase/firestore';
import { habitLogsCollection } from '../../lib/firestore';
import type { HabitLog } from '../../types';

export function useHabitLogs(
  userId: string | null,
  workspaceId: string | null,
  habitId: string | null
) {
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !workspaceId || !habitId) {
      setLogs([]);
      setLoading(false);
      return;
    }

    const q = query(
      habitLogsCollection(userId, workspaceId),
      where('habitId', '==', habitId),
      orderBy('date', 'asc')
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as HabitLog[];
        setLogs(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId, workspaceId, habitId]);

  const logHabit = async (
    entry: Omit<HabitLog, 'id' | 'createdAt'>
  ): Promise<string> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = await addDoc(habitLogsCollection(userId, workspaceId), {
      ...entry,
      createdAt: Date.now(),
    } as Omit<HabitLog, 'id'>);
    return ref.id;
  };

  return { logs, loading, error, logHabit };
}
