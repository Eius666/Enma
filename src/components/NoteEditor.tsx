import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import {
  FaArrowLeft,
  FaEllipsisV,
  FaStickyNote,
  FaCheckSquare,
  FaPlus,
  FaThumbtack,
  FaTrash,
  FaTimes,
} from 'react-icons/fa';
import { db } from '../firebase';
import type { ChecklistItem } from './NotesList';
import './Notes.css';

interface NoteEditorProps {
  noteId: string | null;        // null = new note
  user: User | null;
  language: 'en' | 'ru';
  initialCategory?: string;
  onBack: () => void;
}

const DEBOUNCE_MS = 500;

const DEFAULT_CATEGORIES_EN = ['General', 'Work', 'Personal', 'Ideas'];
const DEFAULT_CATEGORIES_RU = ['Общее', 'Работа', 'Личное', 'Идеи'];

const T = {
  en: {
    back: 'Notes',
    titlePlaceholder: 'Title',
    contentPlaceholder: 'Start writing…',
    text: 'Text',
    checklist: 'Checklist',
    pin: 'Pin',
    unpin: 'Unpin',
    delete: 'Delete note',
    changeCategory: 'Category',
    addItem: '+ Add item',
    lastEdited: 'Last edited',
    saving: 'Saving…',
    saved: 'Saved',
    confirmDelete: 'Delete this note?',
    todoPlaceholder: 'New item…',
  },
  ru: {
    back: 'Заметки',
    titlePlaceholder: 'Заголовок',
    contentPlaceholder: 'Начните писать…',
    text: 'Текст',
    checklist: 'Чек-лист',
    pin: 'Закрепить',
    unpin: 'Открепить',
    delete: 'Удалить',
    changeCategory: 'Категория',
    addItem: '+ Добавить',
    lastEdited: 'Изменено',
    saving: 'Сохранение…',
    saved: 'Сохранено',
    confirmDelete: 'Удалить эту заметку?',
    todoPlaceholder: 'Новый пункт…',
  },
};

function makeItemId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeNoteId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const NoteEditor: React.FC<NoteEditorProps> = ({
  noteId,
  user,
  language,
  initialCategory,
  onBack,
}) => {
  const t = T[language];
  const defaultCats = language === 'ru' ? DEFAULT_CATEGORIES_RU : DEFAULT_CATEGORIES_EN;

  const [docId, setDocId] = useState<string | null>(noteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<'text' | 'checklist'>('text');
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [category, setCategory] = useState(initialCategory ?? defaultCats[0]);
  const [pinned, setPinned] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ── Load existing note ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const id = noteId ?? makeNoteId();
    setDocId(id);

    if (noteId) {
      // Load from Firestore
      getDoc(doc(db, 'notes', noteId)).then(snap => {
        if (snap.exists()) {
          const d = snap.data();
          setTitle(d.title ?? '');
          setContent(d.content ?? '');
          setType(d.type ?? 'text');
          setChecklistItems(d.checklistItems ?? []);
          setCategory(d.category ?? defaultCats[0]);
          setPinned(d.pinned ?? false);
          const ts = d.updatedAt;
          if (ts?.seconds) setUpdatedAt(new Date(ts.seconds * 1000));
        }
        setLoaded(true);
        // Don't auto-focus on existing note (user is reading)
      }).catch(err => {
        console.warn('NoteEditor load error', err);
        setLoaded(true);
      });
    } else {
      // New note — auto-focus title
      setLoaded(true);
      setTimeout(() => titleRef.current?.focus(), 80);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // ── Debounced save ──────────────────────────────────────────────────────
  const saveToFirestore = useCallback(
    async (
      id: string,
      patch: {
        title: string;
        content: string;
        type: 'text' | 'checklist';
        checklistItems: ChecklistItem[];
        category: string;
        pinned: boolean;
      }
    ) => {
      if (!user) return;
      setSavingState('saving');
      try {
        const now = serverTimestamp();
        const data = {
          ...patch,
          userId: user.uid,
          updatedAt: now,
        };
        const ref = doc(db, 'notes', id);
        // setDoc with merge:true acts as an upsert — creates the doc if absent,
        // updates fields if it exists. We only set createdAt on the first write
        // by using merge:true (Firestore won't overwrite createdAt if it exists).
        await setDoc(ref, { ...data, createdAt: now }, { merge: true });
        setUpdatedAt(new Date());
        setSavingState('saved');
        setTimeout(() => setSavingState('idle'), 1500);
      } catch (err) {
        console.warn('NoteEditor save error', err);
        setSavingState('idle');
      }
    },
    [user]
  );

  const scheduleSave = useCallback(
    (
      id: string,
      patch: {
        title: string;
        content: string;
        type: 'text' | 'checklist';
        checklistItems: ChecklistItem[];
        category: string;
        pinned: boolean;
      }
    ) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveToFirestore(id, patch), DEBOUNCE_MS);
    },
    [saveToFirestore]
  );

  // Trigger save whenever editable fields change
  useEffect(() => {
    if (!loaded || !docId) return;
    scheduleSave(docId, { title, content, type, checklistItems, category, pinned });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, type, checklistItems, category, pinned, loaded]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // ── Type toggle ─────────────────────────────────────────────────────────
  const handleTypeChange = (newType: 'text' | 'checklist') => {
    if (newType === type) return;
    if (newType === 'checklist' && checklistItems.length === 0) {
      // Migrate content lines to checklist items
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        setChecklistItems(lines.map(l => ({ id: makeItemId(), text: l, checked: false })));
      } else {
        setChecklistItems([{ id: makeItemId(), text: '', checked: false }]);
      }
      setContent('');
    } else if (newType === 'text' && checklistItems.length > 0) {
      // Migrate checklist items to text lines
      setContent(checklistItems.map(i => i.text).join('\n'));
      setChecklistItems([]);
    }
    setType(newType);
  };

  // ── Checklist helpers ───────────────────────────────────────────────────
  const updateItem = (itemId: string, patch: Partial<ChecklistItem>) => {
    setChecklistItems(prev =>
      prev.map(i => (i.id === itemId ? { ...i, ...patch } : i))
    );
  };

  const addItem = () => {
    const newItem: ChecklistItem = { id: makeItemId(), text: '', checked: false };
    setChecklistItems(prev => [...prev, newItem]);
    // Focus new item after next render
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('.note-editor__check-input');
      inputs[inputs.length - 1]?.focus();
    }, 50);
  };

  const removeItem = (itemId: string) => {
    setChecklistItems(prev => prev.filter(i => i.id !== itemId));
  };

  // ── Textarea auto-resize ────────────────────────────────────────────────
  const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };

  // ── Pin toggle ──────────────────────────────────────────────────────────
  const handlePin = async () => {
    const next = !pinned;
    setPinned(next);
    setMenuOpen(false);
    if (!docId) return;
    try {
      await setDoc(
        doc(db, 'notes', docId),
        { pinned: next, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      console.warn('Pin error', err);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    setMenuOpen(false);
    if (!docId) { onBack(); return; }
    if (!window.confirm(t.confirmDelete)) return;
    try {
      await deleteDoc(doc(db, 'notes', docId));
    } catch (err) {
      console.warn('Delete error', err);
    }
    onBack();
  };

  // ── Format updatedAt display ────────────────────────────────────────────
  const formatUpdatedAt = (): string => {
    if (!updatedAt) return '';
    return updatedAt.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!loaded) {
    return (
      <div className="note-editor">
        <div className="note-editor__toolbar">
          <button className="note-editor__back-btn" onClick={onBack} type="button">
            <FaArrowLeft /> {t.back}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="note-editor">
      {/* ── Toolbar ── */}
      <div className="note-editor__toolbar">
        <button className="note-editor__back-btn" onClick={onBack} type="button">
          <FaArrowLeft /> {t.back}
        </button>

        <div className="note-editor__toolbar-actions" ref={menuRef}>
          {savingState === 'saving' && (
            <span className="note-editor__saving">
              <span className="note-editor__saving-dot" />
              {t.saving}
            </span>
          )}
          <button
            className="note-editor__menu-btn"
            onClick={() => setMenuOpen(prev => !prev)}
            type="button"
            aria-label="More options"
          >
            <FaEllipsisV />
          </button>

          {menuOpen && (
            <div className="note-editor__dropdown">
              <button
                className="note-editor__dropdown-item"
                onClick={handlePin}
                type="button"
              >
                <FaThumbtack /> {pinned ? t.unpin : t.pin}
              </button>
              <div className="note-editor__dropdown-separator" />
              {/* Category selector */}
              <div className="note-editor__dropdown-cat">
                <span className="note-editor__dropdown-cat-label">{t.changeCategory}:</span>
                <select
                  className="note-editor__dropdown-cat-select"
                  value={category}
                  onChange={e => { setCategory(e.target.value); setMenuOpen(false); }}
                >
                  {defaultCats.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="note-editor__dropdown-separator" />
              <button
                className="note-editor__dropdown-item note-editor__dropdown-item--danger"
                onClick={handleDelete}
                type="button"
              >
                <FaTrash /> {t.delete}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Title ── */}
      <input
        ref={titleRef}
        className="note-editor__title-input"
        type="text"
        placeholder={t.titlePlaceholder}
        value={title}
        onChange={e => setTitle(e.target.value)}
      />

      {/* ── Type toggle ── */}
      <div className="note-editor__type-toggle">
        <button
          className={`note-editor__type-btn${type === 'text' ? ' note-editor__type-btn--active' : ''}`}
          onClick={() => handleTypeChange('text')}
          type="button"
        >
          <FaStickyNote /> {t.text}
        </button>
        <button
          className={`note-editor__type-btn${type === 'checklist' ? ' note-editor__type-btn--active' : ''}`}
          onClick={() => handleTypeChange('checklist')}
          type="button"
        >
          <FaCheckSquare /> {t.checklist}
        </button>
      </div>

      {/* ── Content ── */}
      {type === 'text' ? (
        <textarea
          className="note-editor__textarea"
          placeholder={t.contentPlaceholder}
          value={content}
          onChange={e => setContent(e.target.value)}
          onInput={handleTextareaInput}
          rows={6}
        />
      ) : (
        <>
          <div className="note-editor__checklist">
            {checklistItems.map(item => (
              <div key={item.id} className="note-editor__check-item">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={() => updateItem(item.id, { checked: !item.checked })}
                />
                <input
                  className={`note-editor__check-input${item.checked ? ' note-editor__check-input--done' : ''}`}
                  type="text"
                  placeholder={t.todoPlaceholder}
                  value={item.text}
                  onChange={e => updateItem(item.id, { text: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); addItem(); }
                    if (e.key === 'Backspace' && !item.text && checklistItems.length > 1) {
                      e.preventDefault();
                      removeItem(item.id);
                    }
                  }}
                />
                <button
                  className="note-editor__check-remove"
                  onClick={() => removeItem(item.id)}
                  type="button"
                  tabIndex={-1}
                >
                  <FaTimes />
                </button>
              </div>
            ))}
          </div>
          <button
            className="note-editor__add-item-btn"
            onClick={addItem}
            type="button"
          >
            <FaPlus /> {t.addItem}
          </button>
        </>
      )}

      {/* ── Footer ── */}
      {updatedAt && (
        <div className="note-editor__footer">
          {t.lastEdited}: {formatUpdatedAt()}
        </div>
      )}
    </div>
  );
};

export default NoteEditor;
