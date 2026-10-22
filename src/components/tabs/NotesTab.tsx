import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import NotesList from '../NotesList';
import NoteEditor from '../NoteEditor';
import type { Subscription } from '../../subscription';
import type { Language } from '../../types/app';

interface Props {
  language: Language;
  user: User;
  subscription: Subscription | null;
}

// "Notes" tab: the list and the editor (also opened on a recovered unsaved
// draft). The list/editor state is local and resets when the tab is left.
export function NotesTab({ language, user, subscription }: Props): React.ReactElement {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  // Set only when opening a note recovered from NotesList's "unsaved note"
  // banner — see NoteEditor's recoveredDraftId prop.
  const [recoveredDraftId, setRecoveredDraftId] = useState<string | null>(null);

  return (
    <>
      {view === 'list' && (
        <NotesList
          user={user}
          language={language}
          onOpenEditor={(id) => {
            setActiveNoteId(id);
            setRecoveredDraftId(null);
            setView('editor');
          }}
          onRecoverDraft={(draftId) => {
            setActiveNoteId(null);
            setRecoveredDraftId(draftId);
            setView('editor');
          }}
        />
      )}
      {view === 'editor' && (
        <NoteEditor
          noteId={activeNoteId}
          recoveredDraftId={recoveredDraftId}
          user={user}
          language={language}
          subscription={subscription}
          onBack={() => {
            setView('list');
            setActiveNoteId(null);
            setRecoveredDraftId(null);
          }}
        />
      )}
    </>
  );
}
