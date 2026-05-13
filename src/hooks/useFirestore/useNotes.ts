import { useState, useEffect } from 'react';
import { onSnapshot, query, orderBy, addDoc, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { notesCollection } from '../../lib/firestore';
import { db } from '../../src/firebase';
import type { Note } from '../../types';

export function useNotes(userId: string | null, workspaceId: string | null) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !workspaceId) {
      setNotes([]);
      setLoading(false);
      return;
    }

    const q = query(
      notesCollection(userId, workspaceId),
      orderBy('updatedAt', 'desc')
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Note[];
        setNotes(data);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [userId, workspaceId]);

  const addNote = async (note: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const now = Date.now();
    const ref = await addDoc(notesCollection(userId, workspaceId), {
      ...note,
      createdAt: now,
      updatedAt: now,
    } as Omit<Note, 'id'>);
    return ref.id;
  };

  const updateNote = async (noteId: string, patch: Partial<Omit<Note, 'id'>>): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'notes', noteId);
    await updateDoc(ref, { ...patch, updatedAt: Date.now() });
  };

  const deleteNote = async (noteId: string): Promise<void> => {
    if (!userId || !workspaceId) throw new Error('No active user or workspace');
    const ref = doc(db, 'users', userId, 'workspaces', workspaceId, 'notes', noteId);
    await deleteDoc(ref);
  };

  return { notes, loading, error, addNote, updateNote, deleteNote };
}
