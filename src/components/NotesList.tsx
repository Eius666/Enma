import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  deleteDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import {
  FaSearch,
  FaStickyNote,
  FaCheckSquare,
  FaThumbtack,
  FaTrash,
  FaPlus,
  FaTimes,
} from 'react-icons/fa';
import { db } from '../firebase';
import { getNoteDraftStore } from '../lib/noteDrafts';
import type { NoteDraft } from '../lib/noteDrafts';
import { perfMark } from '../lib/perfMarks';
import './Notes.css';

export interface FireNote {
  id: string;
  userId: string;
  title: string;
  content: string;
  checklistItems?: ChecklistItem[];
  type: 'text' | 'checklist';
  category: string;
  pinned: boolean;
  createdAt: { seconds: number } | null;
  updatedAt: { seconds: number } | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

interface NotesListProps {
  user: User | null;
  language: 'en' | 'ru';
  onOpenEditor: (noteId: string | null) => void;
  /** Opens NoteEditor on a recovered, never-synced new note's local id. */
  onRecoverDraft: (draftId: string) => void;
}

const DEFAULT_CATEGORIES_EN = ['All', 'General', 'Work', 'Personal', 'Ideas'];
const DEFAULT_CATEGORIES_RU = ['Все', 'Общее', 'Работа', 'Личное', 'Идеи'];

const T = {
  en: {
    search: 'Search notes…',
    pinned: 'Pinned',
    allNotes: 'All Notes',
    emptyTitle: 'No notes yet',
    emptyHint: 'Tap + to create a note',
    emptySearchTitle: 'Nothing found',
    emptySearchHint: 'Try a different search',
    pin: 'Pin',
    unpin: 'Unpin',
    delete: 'Delete',
    cancel: 'Cancel',
    newCategory: 'New category',
    categoryPlaceholder: 'Category name',
    confirmDelete: 'Delete this note?',
    actions: 'Actions',
    unsavedTitle: 'Unsaved note found on this device',
    unsavedHint: 'This note was never saved online',
    recover: 'Open',
    discard: 'Discard',
    loadErrorTitle: "Couldn't load your notes",
    loadErrorHint: 'This is not the same as having no notes — your notes may still be there.',
    retry: 'Retry',
  },
  ru: {
    search: 'Поиск заметок…',
    pinned: 'Закреплённые',
    allNotes: 'Все заметки',
    emptyTitle: 'Заметок пока нет',
    emptyHint: 'Нажмите + чтобы создать заметку',
    emptySearchTitle: 'Ничего не найдено',
    emptySearchHint: 'Попробуйте другой запрос',
    pin: 'Закрепить',
    unpin: 'Открепить',
    delete: 'Удалить',
    cancel: 'Отмена',
    newCategory: 'Новая категория',
    categoryPlaceholder: 'Название категории',
    confirmDelete: 'Удалить эту заметку?',
    actions: 'Действия',
    unsavedTitle: 'Найдена несохранённая заметка на этом устройстве',
    unsavedHint: 'Эта заметка никогда не была сохранена онлайн',
    recover: 'Открыть',
    discard: 'Удалить',
    loadErrorTitle: 'Не удалось загрузить заметки',
    loadErrorHint: 'Это не значит, что заметок нет — возможно, они всё ещё на месте.',
    retry: 'Повторить',
  },
};

function tsToDate(ts: { seconds: number } | null): Date | null {
  if (!ts) return null;
  return new Date(ts.seconds * 1000);
}

function formatNoteDate(ts: { seconds: number } | null, language: 'en' | 'ru'): string {
  const d = tsToDate(ts);
  if (!d) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (language === 'ru') {
    if (mins < 1) return 'только что';
    if (mins < 60) return `${mins} мин назад`;
    if (hours < 24) return `${hours} ч назад`;
    if (days === 1) return 'вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } else {
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

function notePreview(note: FireNote): string {
  if (note.type === 'checklist' && note.checklistItems?.length) {
    return note.checklistItems
      .slice(0, 3)
      .map(item => `${item.checked ? '✓' : '○'} ${item.text}`)
      .join('  ·  ');
  }
  return note.content?.slice(0, 120) ?? '';
}

const NotesList: React.FC<NotesListProps> = ({ user, language, onOpenEditor, onRecoverDraft }) => {
  const t = T[language];
  const defaultCats = language === 'ru' ? DEFAULT_CATEGORIES_RU : DEFAULT_CATEGORIES_EN;
  const allLabel = defaultCats[0];

  const [notes, setNotes] = useState<FireNote[]>([]);
  // ENMA notes-durability audit — incident: a FAILED_PRECONDITION (missing
  // composite index) from onSnapshot was only console.warn'ed, leaving
  // `notes` at its initial empty array forever — indistinguishable in the
  // UI from "this account genuinely has zero notes" (showed the empty
  // state, not an error). loadError makes that distinction explicit so
  // the UI can never claim "no notes" when it actually means "couldn't
  // load notes".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [orphanDrafts, setOrphanDrafts] = useState<NoteDraft[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(allLabel);
  const [extraCategories, setExtraCategories] = useState<string[]>([]);
  const [contextNoteId, setContextNoteId] = useState<string | null>(null);
  const [showCatModal, setShowCatModal] = useState(false);
  const [catDraft, setCatDraft] = useState('');

  // Long-press detection
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressNoteId = useRef<string | null>(null);

  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) { setNotes([]); setLoadError(null); return; }

    let mounted = true;
    let unsub: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (!mounted) return;
      const q = query(
        collection(db, 'notes'),
        where('userId', '==', uid),
        orderBy('updatedAt', 'desc')
      );
      unsub = onSnapshot(
        q,
        snap => {
          if (!mounted) return;
          perfMark('first-snapshot:notes');
          setLoadError(null);
          const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as FireNote));
          // Sort client-side: pinned first, then by updatedAt desc (already ordered by query)
          data.sort((a, b) => {
            if (a.pinned === b.pinned) return 0;
            return a.pinned ? -1 : 1;
          });
          setNotes(data);
        },
        err => {
          if (!mounted) return;
          console.warn('NotesList onSnapshot error', err);
          // Deliberately NOT setNotes([]) here — a transient error must
          // never erase an already-successfully-loaded list; it only ever
          // adds the error banner on top of whatever's currently shown.
          setLoadError(err.code || err.message || 'unknown');
        }
      );
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
      if (unsub) unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid ?? null, retryTick]);

  const handleRetryLoad = useCallback(() => {
    setLoadError(null);
    setRetryTick(t => t + 1);
  }, []);

  // ENMA notes-durability audit — recover new notes that never reached
  // Firestore. A note that never completed its first create (offline, or
  // the app/WebView was killed before entityCreate finished) has no
  // server document at all, so it can never appear in the `notes` query
  // above — its ONLY trace is the local draft (src/lib/noteDrafts.ts)
  // saved on every keystroke, keyed by a noteId nobody else knows. This
  // re-checks local storage whenever the live Firestore list changes, and
  // surfaces anything whose id isn't (yet) a real note as recoverable.
  //
  // A draft can also legitimately exist for a note that IS already in
  // Firestore (actively being edited right now, debounce not fired yet) —
  // filtering those out by id is what keeps this from flagging ordinary,
  // healthy in-progress edits as "lost".
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) { setOrphanDrafts([]); return; }
    let mounted = true;
    const knownIds = new Set(notes.map(n => n.id));
    getNoteDraftStore().listForUser(uid).then(drafts => {
      if (!mounted) return;
      const hasContent = (d: NoteDraft) =>
        d.title.trim() !== '' || d.content.trim() !== '' || d.checklistItems.some(i => i.text.trim() !== '');
      setOrphanDrafts(drafts.filter(d => !knownIds.has(d.noteId) && hasContent(d)));
    }).catch(() => {
      if (mounted) setOrphanDrafts([]);
    });
    return () => { mounted = false; };
  }, [user?.uid, notes]);

  const handleDiscardDraft = useCallback(async (draft: NoteDraft) => {
    await getNoteDraftStore().clear(draft.uid, draft.noteId);
    setOrphanDrafts(prev => prev.filter(d => d.noteId !== draft.noteId));
  }, []);

  // Derive categories from notes + defaults
  const categories = useMemo(() => {
    const fromNotes = Array.from(new Set(notes.map(n => n.category).filter(Boolean)));
    const merged = [...defaultCats];
    for (const c of fromNotes) {
      if (!merged.includes(c)) merged.push(c);
    }
    for (const c of extraCategories) {
      if (!merged.includes(c)) merged.push(c);
    }
    return merged;
  }, [notes, extraCategories, defaultCats]);

  // If active category was removed, reset to all
  useEffect(() => {
    if (!categories.includes(activeCategory)) {
      setActiveCategory(allLabel);
    }
  }, [categories, activeCategory, allLabel]);

  const filtered = useMemo(() => {
    let result = notes;

    // Filter by category
    if (activeCategory !== allLabel) {
      result = result.filter(n => n.category === activeCategory);
    }

    // Filter by search
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        n =>
          n.title.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          n.checklistItems?.some(i => i.text.toLowerCase().includes(q))
      );
    }
    return result;
  }, [notes, activeCategory, allLabel, searchQuery]);

  const pinned = filtered.filter(n => n.pinned);
  const regular = filtered.filter(n => !n.pinned);

  // Context menu note object
  const contextNote = contextNoteId ? notes.find(n => n.id === contextNoteId) : null;

  const handleLongPressStart = useCallback((noteId: string) => {
    longPressNoteId.current = noteId;
    longPressTimer.current = setTimeout(() => {
      setContextNoteId(noteId);
    }, 400);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleNoteClick = useCallback(
    (noteId: string) => {
      // Don't navigate if context menu just opened
      if (longPressTimer.current !== null) {
        handleLongPressEnd();
        return;
      }
      onOpenEditor(noteId);
    },
    [onOpenEditor, handleLongPressEnd]
  );

  const handlePin = useCallback(async () => {
    if (!contextNoteId) return;
    const note = notes.find(n => n.id === contextNoteId);
    if (!note) return;
    try {
      await updateDoc(doc(db, 'notes', contextNoteId), {
        pinned: !note.pinned,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('Pin error', err);
    }
    setContextNoteId(null);
  }, [contextNoteId, notes]);

  const handleDelete = useCallback(async () => {
    if (!contextNoteId) return;
    if (!window.confirm(t.confirmDelete)) { setContextNoteId(null); return; }
    try {
      await deleteDoc(doc(db, 'notes', contextNoteId));
    } catch (err) {
      console.warn('Delete error', err);
    }
    setContextNoteId(null);
  }, [contextNoteId, t]);

  const handleAddCategory = useCallback(() => {
    const name = catDraft.trim();
    if (!name || categories.includes(name)) { setShowCatModal(false); setCatDraft(''); return; }
    setExtraCategories(prev => [...prev, name]);
    setActiveCategory(name);
    setShowCatModal(false);
    setCatDraft('');
  }, [catDraft, categories]);

  const renderNoteRow = (note: FireNote) => (
    <button
      key={note.id}
      className={`notes-list__item${note.pinned ? ' notes-list__item--pinned' : ''}`}
      onClick={() => handleNoteClick(note.id)}
      onTouchStart={() => handleLongPressStart(note.id)}
      onTouchEnd={handleLongPressEnd}
      onTouchMove={handleLongPressEnd}
      onMouseDown={() => handleLongPressStart(note.id)}
      onMouseUp={handleLongPressEnd}
      onMouseLeave={handleLongPressEnd}
      onContextMenu={e => { e.preventDefault(); setContextNoteId(note.id); }}
      type="button"
    >
      <span className={`notes-list__type-icon${note.type === 'checklist' ? ' notes-list__type-icon--checklist' : ''}`}>
        {note.type === 'checklist' ? <FaCheckSquare /> : <FaStickyNote />}
      </span>
      <span className="notes-list__item-body">
        <span className="notes-list__item-title-row">
          {note.pinned && <FaThumbtack className="notes-list__pin-icon" />}
          <span className="notes-list__item-title">
            {note.title || (language === 'ru' ? 'Без названия' : 'Untitled')}
          </span>
        </span>
        {notePreview(note) && (
          <span className="notes-list__item-preview">{notePreview(note)}</span>
        )}
        <span className="notes-list__item-footer">
          <span className="notes-list__item-date">{formatNoteDate(note.updatedAt, language)}</span>
          {note.category && note.category !== allLabel && (
            <span className="notes-list__item-badge">{note.category}</span>
          )}
        </span>
      </span>
    </button>
  );

  const isEmpty = filtered.length === 0;

  return (
    <>
    <div className="notes-list">
      {/* A load error while a (possibly stale) list is still showing —
          the dedicated empty-state error view above only covers the
          isEmpty case; this covers "list currently shows something, but
          a later refresh failed and may be out of date". */}
      {loadError && !isEmpty && (
        <div className="notes-list__load-error-banner" role="alert">
          <span>{t.loadErrorTitle}</span>
          <button type="button" className="notes-list__retry-btn" onClick={handleRetryLoad}>
            {t.retry}
          </button>
        </div>
      )}

      {/* Unsaved-note recovery — see the listForUser effect above */}
      {orphanDrafts.map(draft => (
        <div className="notes-list__orphan-banner" key={draft.noteId} role="alert">
          <div className="notes-list__orphan-text">
            <strong>{t.unsavedTitle}</strong>
            <span>{draft.title || t.unsavedHint}</span>
          </div>
          <div className="notes-list__orphan-actions">
            <button type="button" className="notes-list__orphan-btn" onClick={() => onRecoverDraft(draft.noteId)}>
              {t.recover}
            </button>
            <button
              type="button"
              className="notes-list__orphan-btn notes-list__orphan-btn--secondary"
              onClick={() => {
                if (window.confirm(t.confirmDelete)) handleDiscardDraft(draft);
              }}
            >
              {t.discard}
            </button>
          </div>
        </div>
      ))}

      {/* Search */}
      <div className="notes-list__search-wrap">
        <FaSearch className="notes-list__search-icon" />
        <input
          className="notes-list__search"
          type="text"
          placeholder={t.search}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Category chips */}
      <div className="notes-list__chips-wrap">
        <div className="notes-list__chips">
          {categories.map(cat => (
            <button
              key={cat}
              className={`notes-list__chip${activeCategory === cat ? ' notes-list__chip--active' : ''}`}
              onClick={() => setActiveCategory(cat)}
              type="button"
            >
              {cat}
            </button>
          ))}
        </div>
        <button
          className="notes-list__chip-add"
          onClick={() => setShowCatModal(true)}
          type="button"
          title={t.newCategory}
        >
          <FaPlus />
        </button>
      </div>

      {/* Pinned section */}
      {pinned.length > 0 && (
        <>
          <div className="notes-list__section-label">{t.pinned}</div>
          {pinned.map(renderNoteRow)}
        </>
      )}

      {/* Regular notes section */}
      {pinned.length > 0 && regular.length > 0 && (
        <div className="notes-list__section-label" style={{ marginTop: 8 }}>
          {t.allNotes}
        </div>
      )}
      {regular.map(renderNoteRow)}

      {/* Load-error state — takes priority over the empty state: an
          onSnapshot error (missing index, permission-denied, offline,
          etc.) must never be presented as "you have no notes". */}
      {isEmpty && loadError && (
        <div className="notes-list__empty notes-list__empty--error" role="alert">
          <span className="notes-list__empty-icon">⚠️</span>
          <span className="notes-list__empty-title">{t.loadErrorTitle}</span>
          <span className="notes-list__empty-hint">{t.loadErrorHint}</span>
          <button type="button" className="notes-list__retry-btn" onClick={handleRetryLoad}>
            {t.retry}
          </button>
        </div>
      )}

      {/* Empty state — only shown once we know loading actually succeeded
          and there genuinely are zero notes. */}
      {isEmpty && !loadError && (
        <div className="notes-list__empty">
          <span className="notes-list__empty-icon">📝</span>
          <span className="notes-list__empty-title">
            {searchQuery ? t.emptySearchTitle : t.emptyTitle}
          </span>
          <span className="notes-list__empty-hint">
            {searchQuery ? t.emptySearchHint : t.emptyHint}
          </span>
        </div>
      )}

    </div>

    {/* FAB — outside animated container so position:fixed isn't affected by transform */}
    <button
      className="fab"
      onClick={() => onOpenEditor(null)}
      type="button"
      aria-label={language === 'ru' ? 'Создать заметку' : 'New note'}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>

    {/* Context menu */}
    {contextNoteId && contextNote && (
      <div
        className="notes-context-backdrop"
        onClick={() => setContextNoteId(null)}
      >
        <div className="notes-context-menu" onClick={e => e.stopPropagation()}>
          <div className="notes-context-menu__title">{t.actions}</div>
          <button className="notes-context-menu__action" onClick={handlePin} type="button">
            <FaThumbtack className="notes-context-menu__action-icon" />
            {contextNote.pinned ? t.unpin : t.pin}
          </button>
          <button
            className="notes-context-menu__action notes-context-menu__action--danger"
            onClick={handleDelete}
            type="button"
          >
            <FaTrash className="notes-context-menu__action-icon" />
            {t.delete}
          </button>
          <button
            className="notes-context-menu__cancel"
            onClick={() => setContextNoteId(null)}
            type="button"
          >
            {t.cancel}
          </button>
        </div>
      </div>
    )}

    {/* New category modal */}
    {showCatModal && (
      <div className="notes-cat-modal-backdrop" onClick={() => setShowCatModal(false)}>
        <div className="notes-cat-modal" onClick={e => e.stopPropagation()}>
          <span className="notes-cat-modal__label">{t.newCategory}</span>
          <input
            className="notes-cat-modal__input"
            type="text"
            placeholder={t.categoryPlaceholder}
            value={catDraft}
            onChange={e => setCatDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
            autoFocus
          />
          <div className="notes-cat-modal__btns">
            <button
              className="notes-cat-modal__btn notes-cat-modal__btn--cancel"
              onClick={() => { setShowCatModal(false); setCatDraft(''); }}
              type="button"
            >
              <FaTimes /> {t.cancel}
            </button>
            <button
              className="notes-cat-modal__btn notes-cat-modal__btn--confirm"
              onClick={handleAddCategory}
              type="button"
            >
              {t.newCategory}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default NotesList;
