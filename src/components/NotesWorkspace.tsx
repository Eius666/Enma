import React, { useEffect, useMemo, useState } from 'react';
import { compareAsc, parseISO } from 'date-fns';
import { FaPlus, FaStickyNote, FaTasks, FaTimes, FaTrash } from 'react-icons/fa';
import { translate } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { createId, formatDate } from '../lib/utils';
import type { Language, NoteBlock, NotePage, NoteProject } from '../types';

type NotesWorkspaceProps = {
  language: Language;
  notes: NotePage[];
  noteProjects: NoteProject[];
  onNotesChange: (notes: NotePage[]) => void;
  onNoteProjectsChange: (projects: NoteProject[]) => void;
};

const NotesWorkspace: React.FC<NotesWorkspaceProps> = ({
  language,
  notes,
  noteProjects,
  onNotesChange,
  onNoteProjectsChange
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const [activeNoteType, setActiveNoteType] = useState<'text' | 'checklist'>('text');
  const [composerBody, setComposerBody] = useState('');
  const [projectDraft, setProjectDraft] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(noteProjects[0]?.id ?? '');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (!noteProjects.length) return;
    if (!noteProjects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(noteProjects[0].id);
    }
  }, [noteProjects, selectedProjectId]);

  const filteredNotes = notes.filter(note => note.noteType === activeNoteType);
  const sortedNotes = useMemo(
    () => [...filteredNotes].sort((a, b) => compareAsc(parseISO(b.updatedAt), parseISO(a.updatedAt))),
    [filteredNotes]
  );

  const projectSections = useMemo(
    () =>
      noteProjects
        .map(project => ({ project, notes: sortedNotes.filter(n => n.projectId === project.id) }))
        .filter(section => section.notes.length > 0),
    [noteProjects, sortedNotes]
  );

  const selectedSection = projectSections.find(s => s.project.id === selectedProjectId);
  const activeNote = activeNoteId ? notes.find(n => n.id === activeNoteId) ?? null : null;

  const addProject = () => {
    const name = projectDraft.trim();
    if (!name) return;
    const newProject: NoteProject = { id: createId(), name };
    onNoteProjectsChange([newProject, ...noteProjects]);
    setSelectedProjectId(newProject.id);
    setProjectDraft('');
  };

  const deleteProject = (projectId: string) => {
    if (noteProjects.length <= 1) return;
    const remaining = noteProjects.filter(p => p.id !== projectId);
    const fallbackId = remaining[0]?.id ?? '';
    onNoteProjectsChange(remaining);
    setSelectedProjectId(prev => (prev === projectId ? fallbackId : prev));
    onNotesChange(
      notes.map(note => ({
        ...note,
        projectId: note.projectId === projectId ? fallbackId : note.projectId
      }))
    );
  };

  const updateNote = (noteId: string, updater: (note: NotePage) => NotePage) => {
    onNotesChange(notes.map(note => (note.id === noteId ? updater(note) : note)));
  };

  const addNote = () => {
    if (!composerBody.trim()) return;
    const projectId = selectedProjectId || noteProjects[0]?.id || 'project-default';
    const [firstLine, ...restLines] = composerBody.split('\n');
    const title = firstLine?.trim() || t('noteTitlePlaceholder');
    let blocks: NoteBlock[] = [];
    if (activeNoteType === 'checklist') {
      const items = restLines.map(line => line.trim()).filter(Boolean);
      blocks = items.length
        ? items.map(item => ({ id: createId(), type: 'todo' as const, content: item, checked: false }))
        : [{ id: createId(), type: 'todo' as const, content: '', checked: false }];
    } else {
      const bodyText = restLines.join('\n').trim();
      blocks = [{ id: createId(), type: 'paragraph' as const, content: bodyText || t('startWriting') }];
    }
    const newNote: NotePage = {
      id: createId(),
      title,
      updatedAt: new Date().toISOString(),
      blocks,
      noteType: activeNoteType,
      projectId
    };
    onNotesChange([newNote, ...notes]);
    setComposerBody('');
  };

  const deleteNote = (noteId: string) => onNotesChange(notes.filter(n => n.id !== noteId));

  const updateBlockContent = (noteId: string, blockId: string, content: string) => {
    updateNote(noteId, note => ({
      ...note,
      blocks: note.blocks.map(b => (b.id === blockId ? { ...b, content } : b)),
      updatedAt: new Date().toISOString()
    }));
  };

  const addBlock = (noteId: string) => {
    updateNote(noteId, note => {
      const block: NoteBlock =
        note.noteType === 'checklist'
          ? { id: createId(), type: 'todo', content: '', checked: false }
          : { id: createId(), type: 'paragraph', content: '' };
      return { ...note, blocks: [...note.blocks, block], updatedAt: new Date().toISOString() };
    });
  };

  const toggleTodo = (noteId: string, blockId: string) => {
    updateNote(noteId, note => ({
      ...note,
      blocks: note.blocks.map(b => (b.id === blockId ? { ...b, checked: !b.checked } : b)),
      updatedAt: new Date().toISOString()
    }));
  };

  return (
    <section className="panel notes-panel notes-panel--stacked">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('notesWorkspaceTitle')}</span>
          <h2>{t('notesWorkspaceTitle')}</h2>
          <p className="panel-subtitle">{t('notesWorkspaceSubtitle')}</p>
        </div>
      </header>

      <div className="notes-board">
        <div className="notes-composer">
          <div className="notes-project-tabs">
            {noteProjects.map(project => (
              <button
                key={project.id}
                className={`notes-project-tab ${selectedProjectId === project.id ? 'is-active' : ''}`}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <span>{project.name}</span>
                {selectedProjectId === project.id && noteProjects.length > 1 && (
                  <span
                    role="button"
                    className="notes-project-remove"
                    onClick={e => { e.stopPropagation(); deleteProject(project.id); }}
                  >
                    <FaTimes />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="notes-project-create">
            <input
              value={projectDraft}
              onChange={e => setProjectDraft(e.target.value)}
              placeholder={t('notesProjectPlaceholder')}
            />
            <button className="ghost-button" onClick={addProject}>
              <FaPlus /> {t('addProject')}
            </button>
          </div>
          <textarea
            rows={4}
            className="notes-composer-body notes-composer-body--single"
            value={composerBody}
            onChange={e => setComposerBody(e.target.value)}
            placeholder={t('notesComposerBody')}
          />
          <div className="note-type-switch">
            <button
              className={activeNoteType === 'text' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('text')}
            >
              <FaStickyNote /> {t('noteTypeText')}
            </button>
            <button
              className={activeNoteType === 'checklist' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('checklist')}
            >
              <FaTasks /> {t('noteTypeChecklist')}
            </button>
          </div>
          <button className="primary-button notes-composer-submit" onClick={addNote}>
            <FaPlus /> {t('addNote')}
          </button>
        </div>

        {activeNote ? (
          <div className="note-detail">
            <button className="ghost-button note-detail-back" onClick={() => setActiveNoteId(null)}>
              {t('notesBack')}
            </button>
            <div className="note-detail-header">
              <input
                className="note-detail-title"
                value={activeNote.title}
                onChange={e =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    title: e.target.value,
                    updatedAt: new Date().toISOString()
                  }))
                }
                placeholder={t('noteTitlePlaceholder')}
              />
              <select
                className="note-detail-project"
                value={activeNote.projectId}
                onChange={e =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    projectId: e.target.value,
                    updatedAt: new Date().toISOString()
                  }))
                }
              >
                {noteProjects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="note-detail-body">
              {activeNote.blocks.map(block => (
                <div key={block.id} className="note-card-block">
                  {activeNote.noteType === 'checklist' ? (
                    <label className="note-card-todo">
                      <input
                        type="checkbox"
                        checked={Boolean(block.checked)}
                        onChange={() => toggleTodo(activeNote.id, block.id)}
                      />
                      <input
                        className="block-input"
                        value={block.content}
                        onChange={e => updateBlockContent(activeNote.id, block.id, e.target.value)}
                        placeholder={t('todoPlaceholder')}
                      />
                    </label>
                  ) : (
                    <textarea
                      rows={3}
                      className="block-textarea"
                      value={block.content}
                      onChange={e => updateBlockContent(activeNote.id, block.id, e.target.value)}
                      placeholder={t('textPlaceholder')}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="note-card-actions">
              <button className="ghost-button add-block" onClick={() => addBlock(activeNote.id)}>
                <FaPlus /> {activeNote.noteType === 'checklist' ? t('addItem') : t('addParagraph')}
              </button>
            </div>
          </div>
        ) : (
          <div className="notes-stream">
            {selectedSection ? (
              <div className="note-group">
                <div className="note-group-header">
                  <h4 className="note-group-title">{selectedSection.project.name}</h4>
                </div>
                <div className="note-group-list">
                  {selectedSection.notes.map(note => (
                    <article
                      key={note.id}
                      className={`note-card note-card--${note.noteType}`}
                      onClick={() => setActiveNoteId(note.id)}
                    >
                      <div className="note-card-header">
                        <div>
                          <h3 className="note-card-title-text">
                            {note.title || t('noteTitlePlaceholder')}
                          </h3>
                          <span className="note-card-updated">
                            {formatDate(language, parseISO(note.updatedAt), 'MMM d · h:mm a')}
                          </span>
                        </div>
                        <button
                          className="icon-button"
                          onClick={e => { e.stopPropagation(); deleteNote(note.id); }}
                        >
                          <FaTrash />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="notes-empty">
                {activeNoteType === 'text' ? t('noTextNotes') : t('noChecklists')}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export default NotesWorkspace;
