import { useEffect, useRef } from 'react';
import type { User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { safeGetItem, safeSetItem } from '../lib/safeStorage';
import type { NotePage } from '../types/app';

// One-time copy of notes that only ever lived in this browser's localStorage
// (the old block-based notes) into Firestore `notes` (moved out of App.tsx
// unchanged). Existing Firestore notes are never overwritten; a per-user
// marker makes it run once per browser.
export function useLegacyNotesMigration(user: User | null, notes: NotePage[]): void {
  const notesLsMigrationRef = useRef(false);

  useEffect(() => {
    if (!user || notes.length === 0) return;
    const markerKey = `enma.${user.uid}.notesLsMigrated`;
    if (safeGetItem(markerKey) === '1') return;
    if (notesLsMigrationRef.current) return;
    notesLsMigrationRef.current = true;

    const migrate = async () => {
      for (const page of notes) {
        if (!page.title && page.blocks.length === 0) continue;
        try {
          const ref = doc(db, 'notes', page.id);
          const snap = await getDoc(ref);
          if (snap.exists()) continue;
          const content = page.blocks
            .map(b => (b.type === 'todo' ? `- [${b.checked ? 'x' : ' '}] ${b.content}` : b.content))
            .filter(Boolean)
            .join('\n');
          await setDoc(ref, {
            id: page.id,
            userId: user.uid,
            title: page.title || '(без названия)',
            content,
            type: page.noteType === 'checklist' ? 'checklist' : 'text',
            checklistItems: [],
            category: null,
            pinned: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Free limit exceeded or permissions error — skip note
        }
      }
      safeSetItem(markerKey, '1');
    };

    migrate().catch(() => { /* silent */ });
  }, [user, notes]);
}
