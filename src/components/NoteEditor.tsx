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
import type { Subscription } from '../subscription';
import { getActivePlan, FREE_LIMITS } from '../subscription';
import { subscribeFreeUsage } from '../lib/usageCounters';
import { createNoteSaveQueue, SaveStatus } from '../lib/noteSaveQueue';
import Paywall, { LimitBanner } from './Paywall';
import './Notes.css';

interface NoteEditorProps {
  noteId: string | null;
  user: User | null;
  language: 'en' | 'ru';
  subscription?: Subscription | null;
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
    saveError: 'Could not save — your text is still here, edit it to retry',
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
    saveError: 'Не удалось сохранить — текст на месте, продолжите редактирование для повтора',
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
  subscription,
  initialCategory,
  onBack,
}) => {
  const t = T[language];
  const defaultCats = language === 'ru' ? DEFAULT_CATEGORIES_RU : DEFAULT_CATEGORIES_EN;
  const isNew = !noteId;

  const plan    = getActivePlan(subscription ?? null);
  const isFree  = plan === 'free';
  const limit   = FREE_LIMITS.notes;

  const [docId, setDocId] = useState<string | null>(noteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<'text' | 'checklist'>('text');
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [category, setCategory] = useState(initialCategory ?? defaultCats[0]);
  const [pinned, setPinned] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [savingState, setSavingState] = useState<SaveStatus>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [usedNotes, setUsedNotes] = useState<number | null>(null);
  const limitPassedRef = useRef(false);
  const paywallHitRef = useRef(false);

  const near80 = usedNotes !== null && usedNotes >= Math.floor(limit * 0.8);

  useEffect(() => {
    if (!user || !isFree || !isNew) return;
    return subscribeFreeUsage(user.uid, d => setUsedNotes(d.noteCount));
  }, [user, isFree, isNew]);

  const titleRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  type NotePatch = {
    id: string;
    title: string;
    content: string;
    type: 'text' | 'checklist';
    checklistItems: ChecklistItem[];
    category: string;
    pinned: boolean;
  };

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

  // ── Save queue ───────────────────────────────────────────────────────────
  // ENMA notes audit — PHASE 7/12: a bare debounce timer only cancels a
  // write that hasn't fired yet; once in flight, an earlier (now stale)
  // write could still land AFTER a newer one and silently revert the
  // note. Unmounting (back button, switching tabs, closing the app) used
  // to just clearTimeout() the pending debounce outright — any edit made
  // within the last DEBOUNCE_MS before navigating away was never written
  // at all, with no error and no warning. createNoteSaveQueue (src/lib)
  // fixes both: writes are serialized (never two in flight, always commit
  // in request order) and flush()/cancelAndWait() give unmount and delete
  // a way to settle pending work instead of silently discarding it.
  const writeNote = useCallback(
    async (patch: NotePatch): Promise<void> => {
      if (!user) throw new Error('not signed in');
      const { id, ...fields } = patch;

      if (isNew && !limitPassedRef.current) {
        // First save of this note — create via API (handles the free-plan
        // limit check atomically). The queue guarantees this can only ever
        // run once at a time, so limitPassedRef can't race with itself.
        const token = await user.getIdToken();
        const resp = await fetch('/api/ai/entityCreate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            userId:     user.uid,
            entityType: 'note',
            docId:      id,
            data:       { id, ...fields },
          }),
        });
        if (resp.status === 429) {
          const body = await resp.json().catch(() => ({}));
          setUsedNotes(body.current ?? limit);
          setShowPaywall(true);
          // A 429 is an expected, actionable outcome (paywall), not a
          // transient failure — don't report it as a retryable save error.
          // It's also not a success: nothing was written, so the queue's
          // normal "returned without throwing → saved" status needs to be
          // suppressed here (see paywallHitRef below), or the toolbar would
          // claim "Сохранено" for a note that doesn't exist yet.
          limitPassedRef.current = false;
          paywallHitRef.current = true;
          return;
        }
        if (!resp.ok) throw new Error(`entityCreate failed: ${resp.status}`);
        limitPassedRef.current = true;
        setUpdatedAt(new Date());
        return;
      }

      // Update existing note (or already-created new note on subsequent auto-saves)
      await setDoc(
        doc(db, 'notes', id),
        { ...fields, userId: user.uid, updatedAt: serverTimestamp() },
        { merge: true }
      );
      setUpdatedAt(new Date());
    },
    [user, isNew, limit]
  );

  // The queue is created exactly once and never recreated (that would drop
  // any in-flight/pending work) — writeNoteRef lets it always call the
  // LATEST writeNote closure (fresh `user`/`isNew`/`limit`) through a
  // reference that's stable for the queue's entire lifetime.
  const writeNoteRef = useRef(writeNote);
  writeNoteRef.current = writeNote;

  const idleResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<ReturnType<typeof createNoteSaveQueue<NotePatch>> | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = createNoteSaveQueue<NotePatch>({
      write: (patch) => writeNoteRef.current(patch),
      debounceMs: DEBOUNCE_MS,
      onStatusChange: (status) => {
        if (status === 'saved' && paywallHitRef.current) {
          // writeNote hit the free-plan limit and returned without
          // throwing (it's not a retryable error, the Paywall already
          // covers the UI response) — but nothing was actually written,
          // so this is not a "saved" moment. Go straight back to idle.
          paywallHitRef.current = false;
          setSavingState('idle');
          return;
        }
        setSavingState(status);
        if (idleResetTimer.current) clearTimeout(idleResetTimer.current);
        // 'saved' fades back to idle after a moment, same as before. 'error'
        // does NOT auto-clear — per PHASE 12, it must stay visible (and the
        // text stays editable) until the user retries, not vanish on its own.
        if (status === 'saved') {
          idleResetTimer.current = setTimeout(() => setSavingState(s => (s === 'saved' ? 'idle' : s)), 1500);
        }
      },
    });
  }

  // Trigger save whenever editable fields change
  useEffect(() => {
    if (!loaded || !docId) return;
    saveQueueRef.current?.schedule({ id: docId, title, content, type, checklistItems, category, pinned });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, type, checklistItems, category, pinned, loaded, docId]);

  // Flush on unmount — the exact fix for the "edits silently lost" bug:
  // whatever's still pending gets written now instead of discarded. This
  // is a fire-and-forget (the component is gone, there's no UI left to
  // show "saving"/"saved" to) — the write itself still completes; the
  // Firestore client is a module-level singleton independent of this
  // component's lifecycle, so it isn't cancelled by the unmount either.
  useEffect(() => {
    return () => {
      saveQueueRef.current?.flush().catch(() => {});
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
  // Just updates state — the save-trigger effect above already watches
  // `pinned` and schedules it through the SAME queue as every other field.
  // (It used to also fire its own direct setDoc() here, racing with
  // whatever the debounced content-save was about to write — one write
  // path for every field, no exceptions, is the fix.)
  const handlePin = () => {
    setPinned(prev => !prev);
    setMenuOpen(false);
  };

  // ── Delete ──────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    setMenuOpen(false);
    if (!docId) { onBack(); return; }
    if (!window.confirm(t.confirmDelete)) return;
    // Discard any pending auto-save first — flush() would write stale
    // content into a document about to be removed, silently recreating it
    // right after delete (setDoc(…, {merge:true}) on a missing doc just
    // creates it). Still wait for anything already mid-write so it can't
    // land AFTER the delete either.
    await saveQueueRef.current?.cancelAndWait();
    try {
      await deleteDoc(doc(db, 'notes', docId));
    } catch (err) {
      console.warn('Delete error', err);
    }
    onBack();
  };

  // ── Back ────────────────────────────────────────────────────────────────
  // Flushes any still-pending edit (debounced or in-flight) and waits for
  // it before navigating away — the explicit, user-facing counterpart to
  // the unmount flush above. On failure, stays on screen: the typed text
  // is untouched (local state was never cleared) and savingState shows
  // the error, so editing again naturally retries via the normal debounce.
  const handleBack = async () => {
    if (!saveQueueRef.current?.hasPendingWork()) { onBack(); return; }
    const ok = await saveQueueRef.current.flush();
    if (!ok) return;
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

      {showPaywall && (
        <Paywall
          featureName={language === 'ru' ? `заметки (лимит ${limit})` : `notes (limit ${limit})`}
          language={language}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); onBack(); }}
        />
      )}

      {isNew && isFree && near80 && !showPaywall && (
        <LimitBanner
          message={language === 'ru'
            ? `Заметки: ${usedNotes}/${limit}`
            : `Notes: ${usedNotes}/${limit}`}
          onUpgrade={() => setShowPaywall(true)}
          upgradeLabel={language === 'ru' ? 'Убрать лимит' : 'Remove limit'}
        />
      )}

      {/* ── Toolbar ── */}
      <div className="note-editor__toolbar">
        <button
          className="note-editor__back-btn"
          onClick={handleBack}
          disabled={savingState === 'saving'}
          type="button"
        >
          <FaArrowLeft /> {t.back}
        </button>

        <div className="note-editor__toolbar-actions" ref={menuRef}>
          {savingState === 'saving' && (
            <span className="note-editor__saving">
              <span className="note-editor__saving-dot" />
              {t.saving}
            </span>
          )}
          {savingState === 'saved' && (
            <span className="note-editor__saving note-editor__saving--saved">
              {t.saved}
            </span>
          )}
          {savingState === 'error' && (
            <span className="note-editor__saving note-editor__saving--error" role="alert">
              {t.saveError}
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
