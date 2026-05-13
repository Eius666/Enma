import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy, addDoc } from 'firebase/firestore';
import { transactionsCollection } from '../../lib/firestore';
import type { FinanceTransaction } from '../../types';

export function useTransactions(userId: string | null, workspaceId: string | null) {
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !workspaceId) {
      setTransactions([]);
      setLoading(false);
      return;
    }

    const q = query(
      transactionsCollection(userId, workspaceId),
      orderBy('date', 'desc')
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as FinanceTransaction[];
        setTransactions(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId, workspaceId]);

  const addTransaction = async (
    tx: Omit<FinanceTransaction, 'id' | 'createdAt'>
  ): Promise<string> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const now = Date.now();
    const ref = await addDoc(transactionsCollection(userId, workspaceId), {
      ...tx,
      createdAt: now,
    } as Omit<FinanceTransaction, 'id'>);
    return ref.id;
  };

  return { transactions, loading, error, addTransaction };
}
