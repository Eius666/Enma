import React, { useCallback, useState } from 'react';
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
// draft). The open folder is kept here, so it survives opening the editor and
// a new note is created in it; everything resets when the tab is left.
export function NotesTab({ language, user, subscription }: Props): React.ReactElement {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  // Set only when opening a note recovered from NotesList's "unsaved note"
  // banner — see NoteEditor's recoveredDraftId prop.
  const [recoveredDraftId, setRecoveredDraftId] = useState<string | null>(null);
  // The open folder (a note category; null = all notes) and folders added in
  // this session that no note uses yet.
  const [folder, setFolder] = useState<string | null>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  // The folder a new note goes to — taken when "new note" is pressed, so a
  // later folder change cannot move a note that is already being written.
  const [newNoteFolder, setNewNoteFolder] = useState<string | null>(null);

  const addFolder = useCallback((name: string) => {
    setExtraFolders(prev => (prev.includes(name) ? prev : [...prev, name]));
  }, []);

  return (
    <>
      {view === 'list' && (
        <NotesList
          user={user}
          language={language}
          folder={folder}
          onFolderChange={setFolder}
          extraFolders={extraFolders}
          onAddFolder={addFolder}
          onOpenEditor={(id) => {
            setActiveNoteId(id);
            setRecoveredDraftId(null);
            setNewNoteFolder(id === null ? folder : null);
            setView('editor');
          }}
          onRecoverDraft={(draftId) => {
            setActiveNoteId(null);
            setRecoveredDraftId(draftId);
            setNewNoteFolder(null);
            setView('editor');
          }}
        />
      )}
      {view === 'editor' && (
        <NoteEditor
          noteId={activeNoteId}
          recoveredDraftId={recoveredDraftId}
          initialCategory={newNoteFolder ?? undefined}
          user={user}
          language={language}
          subscription={subscription}
          onBack={() => {
            setView('list');
            setActiveNoteId(null);
            setRecoveredDraftId(null);
            setNewNoteFolder(null);
          }}
        />
      )}
    </>
  );
}
