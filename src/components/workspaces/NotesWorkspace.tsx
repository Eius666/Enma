import React, { useEffect, useMemo, useState } from 'react';
import { compareAsc, parseISO } from 'date-fns';
import { FaPlus, FaStickyNote, FaTasks, FaTimes, FaTrash } from 'react-icons/fa';
import { createT } from '../../i18n/createT';
import { formatDate } from '../../utils/formatDate';
import { createId } from './types';
import type { Language, NoteBlock, NotePage, NoteProject } from './types';

type NotesWorkspaceProps = {
  language: Language;
  notes: NotePage[];
  noteProjects: NoteProject[];
  onNotesChange: (notes: NotePage[]) => void;
  onNoteProjectsChange: (projects: NoteProject[]) => void;
};

export const NotesWorkspace: React.FC<NotesWorkspaceProps> = ({
  language,
  notes,
  noteProjects,
  onNotesChange,
  onNoteProjectsChange,
}) => {
  const t = createT(language);
  const [activeNoteType, setActiveNoteType] = useState<'text' | 'checklist'>('text');
  const [composerBody, setComposerBody] = useState('');
  const [projectDraft, setProjectDraft] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(noteProjects[0]?.id ?? '');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (!noteProjects.length) return;
    if (!noteProjects.find(project => project.id === selectedProjectId)) {
      setSelectedProjectId(noteProjects[0].id);
    }
  }, [noteProjects, selectedProjectId]);

  const filteredNotes = notes.filter(note => note.noteType === activeNoteType);
  const sortedNotes = useMemo(
    () =>
      [...filteredNotes].sort((a, b) => compareAsc(parseISO(b.updatedAt), parseISO(a.updatedAt))),
    [filteredNotes]
  );

  const projectSections = useMemo(
    () =>
      noteProjects
        .map(project => ({
          project,
          notes: sortedNotes.filter(note => note.projectId === project.id),
        }))
        .filter(section => section.notes.length > 0),
    [noteProjects, sortedNotes]
  );

  const selectedSection = projectSections.find(
    section => section.project.id === selectedProjectId
  );

  const activeNote = activeNoteId ? notes.find(note => note.id === activeNoteId) ?? null : null;

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
    const remaining = noteProjects.filter(project => project.id !== projectId);
    const fallbackId = remaining[0]?.id ?? '';
    onNoteProjectsChange(remaining);
    setSelectedProjectId(prev => (prev === projectId ? fallbackId : prev));
    onNotesChange(
      notes.map(note => ({
        ...note,
        projectId: note.projectId === projectId ? fallbackId : note.projectId,
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
    const title = firstLine?.trim() || t('notes.titlePlaceholder');
    const bodyText = restLines.join('\n').trim();
    let blocks: NoteBlock[] = [];
    if (activeNoteType === 'checklist') {
      const items = restLines.map(line => line.trim()).filter(Boolean);
      blocks = items.length
        ? items.map(item => ({ id: createId(), type: 'todo' as const, content: item, checked: false }))
        : [{ id: createId(), type: 'todo' as const, content: '', checked: false }];
    } else {
      blocks = [{ id: createId(), type: 'paragraph' as const, content: bodyText || t('notes.startWriting') }];
    }
    const newNote: NotePage = {
      id: createId(),
      title,
      updatedAt: new Date().toISOString(),
      blocks,
      noteType: activeNoteType,
      projectId,
    };
    onNotesChange([newNote, ...notes]);
    setComposerBody('');
  };

  const deleteNote = (noteId: string) => {
    onNotesChange(notes.filter(note => note.id !== noteId));
  };

  const updateBlockContent = (noteId: string, blockId: string, content: string) => {
    updateNote(noteId, note => {
      const newBlocks = note.blocks.map(block =>
        block.id === blockId ? { ...block, content } : block
      );
      return { ...note, blocks: newBlocks, updatedAt: new Date().toISOString() };
    });
  };

  const addBlock = (noteId: string) => {
    updateNote(noteId, note => {
      const blockTemplate: NoteBlock =
        note.noteType === 'checklist'
          ? { id: createId(), type: 'todo', content: '', checked: false }
          : { id: createId(), type: 'paragraph', content: '' };
      return { ...note, blocks: [...note.blocks, blockTemplate], updatedAt: new Date().toISOString() };
    });
  };

  const toggleTodo = (noteId: string, blockId: string) => {
    updateNote(noteId, note => {
      const newBlocks = note.blocks.map(block =>
        block.id === blockId ? { ...block, checked: !block.checked } : block
      );
      return { ...note, blocks: newBlocks, updatedAt: new Date().toISOString() };
    });
  };

  return (
    <section className="panel notes-panel notes-panel--stacked">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('notes.workspaceTitle')}</span>
          <h2>{t('notes.workspaceTitle')}</h2>
          <p className="panel-subtitle">{t('notes.workspaceSubtitle')}</p>
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
                    onClick={event => {
                      event.stopPropagation();
                      deleteProject(project.id);
                    }}
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
              onChange={event => setProjectDraft(event.target.value)}
              placeholder={t('notes.projectPlaceholder')}
            />
            <button className="ghost-button" onClick={addProject}>
              <FaPlus /> {t('notes.addProject')}
            </button>
          </div>
          <textarea
            rows={4}
            className="notes-composer-body notes-composer-body--single"
            value={composerBody}
            onChange={event => setComposerBody(event.target.value)}
            placeholder={t('notes.composerBody')}
          />
          <div className="note-type-switch">
            <button
              className={activeNoteType === 'text' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('text')}
            >
              <FaStickyNote /> {t('notes.typeText')}
            </button>
            <button
              className={activeNoteType === 'checklist' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('checklist')}
            >
              <FaTasks /> {t('notes.typeChecklist')}
            </button>
          </div>
          <button className="primary-button notes-composer-submit" onClick={addNote}>
            <FaPlus /> {t('notes.add')}
          </button>
        </div>

        {activeNote ? (
          <div className="note-detail">
            <button className="ghost-button note-detail-back" onClick={() => setActiveNoteId(null)}>
              {t('notes.back')}
            </button>
            <div className="note-detail-header">
              <input
                className="note-detail-title"
                value={activeNote.title}
                onChange={event =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    title: event.target.value,
                    updatedAt: new Date().toISOString(),
                  }))
                }
                placeholder={t('notes.titlePlaceholder')}
              />
              <select
                className="note-detail-project"
                value={activeNote.projectId}
                onChange={event =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    projectId: event.target.value,
                    updatedAt: new Date().toISOString(),
                  }))
                }
              >
                {noteProjects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
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
                        onChange={event =>
                          updateBlockContent(activeNote.id, block.id, event.target.value)
                        }
                        placeholder={t('notes.todoPlaceholder')}
                      />
                    </label>
                  ) : (
                    <textarea
                      rows={3}
                      className="block-textarea"
                      value={block.content}
                      onChange={event =>
                        updateBlockContent(activeNote.id, block.id, event.target.value)
                      }
                      placeholder={t('notes.textPlaceholder')}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="note-card-actions">
              <button className="ghost-button add-block" onClick={() => addBlock(activeNote.id)}>
                <FaPlus />{' '}
                {activeNote.noteType === 'checklist' ? t('notes.addItem') : t('notes.addParagraph')}
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
                            {note.title || t('notes.titlePlaceholder')}
                          </h3>
                          <span className="note-card-updated">
                            {formatDate(language, parseISO(note.updatedAt), 'MMM d · h:mm a')}
                          </span>
                        </div>
                        <button
                          className="icon-button"
                          onClick={event => {
                            event.stopPropagation();
                            deleteNote(note.id);
                          }}
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
                {activeNoteType === 'text' ? t('notes.noTextNotes') : t('notes.noChecklists')}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
