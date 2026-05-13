import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy } from 'firebase/firestore';
import { workspacesCollection } from '../../lib/firestore';
import type { Workspace } from '../../types';

export function useWorkspaces(userId: string | null) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setWorkspaces([]);
      setLoading(false);
      return;
    }

    const q = query(workspacesCollection(userId), orderBy('order', 'asc'));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Workspace[];
        setWorkspaces(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId]);

  return { workspaces, loading, error };
}
