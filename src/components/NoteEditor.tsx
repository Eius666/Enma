import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  doc,
  deleteDoc,
  getDoc,
  runTransaction,
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
import { getNoteDraftStore, decideDraftAction } from '../lib/noteDrafts';
import { NoteConflictError, classifyWriteError } from '../lib/noteSyncStatus';
import Paywall, { LimitBanner } from './Paywall';
import './Notes.css';

interface NoteEditorProps {
  noteId: string | null;
  user: User | null;
  language: 'en' | 'ru';
  subscription?: Subscription | null;
  initialCategory?: string;
  onBack: () => void;
  /**
   * Set when opening a draft recovered from NotesList's "unsaved note"
   * banner (src/lib/noteDrafts.ts) — a new note whose first create never
   * reached Firestore (offline/killed before entityCreate completed), so
   * there is no server document and no noteId anyone outside this local
   * draft knows about. Distinct from `noteId`: passing a recovered id
   * here still goes through the free-tier-limited entityCreate path on
   * first save (isNew stays true), just reusing this id instead of
   * minting a fresh one, so recovering twice can't create a duplicate.
   */
  recoveredDraftId?: string | null;
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
    offlinePending: 'No connection — changes saved on this device',
    conflictTitle: 'Version conflict',
    conflictBody: 'This note changed elsewhere since you opened it. Choose which version to keep.',
    keepMine: 'Keep mine',
    useTheirs: 'Use their version',
    restoredHint: 'Restored unsaved changes from this device',
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
    offlinePending: 'Нет соединения — изменения сохранены на устройстве',
    conflictTitle: 'Конфликт версий',
    conflictBody: 'Эта заметка изменилась в другом месте с момента открытия. Выберите, какую версию оставить.',
    keepMine: 'Оставить моё',
    useTheirs: 'Использовать их версию',
    restoredHint: 'Восстановлены несохранённые изменения с этого устройства',
    confirmDelete: 'Удалить эту заметку?',
    todoPlaceholder: 'Новый пункт…',
  },
};

const OFFLINE_HINT_MS = 6000;

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
  recoveredDraftId,
}) => {
  const t = T[language];
  const defaultCats = language === 'ru' ? DEFAULT_CATEGORIES_RU : DEFAULT_CATEGORIES_EN;
  // recoveredDraftId deliberately does NOT flip isNew to false — it's a
  // new note (never created on the server) that's reusing a known local
  // id instead of minting a fresh one. See NoteEditorProps for why.
  const isNew = !noteId;

  const plan    = getActivePlan(subscription ?? null);
  const isFree  = plan === 'free';
  const limit   = FREE_LIMITS.notes;

  const [docId, setDocId] = useState<string | null>(noteId ?? recoveredDraftId ?? null);
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

  // ── Durability / conflict state (ENMA notes-durability audit) ───────────
  // knownRevRef tracks the server `rev` this editor last confirmed loading
  // or writing — the basis for optimistic-concurrency checks (PHASE 4) and
  // for deciding whether a leftover local draft is safe to restore
  // (PHASE 3). Not used for brand-new notes (nothing to conflict with yet).
  const knownRevRef = useRef<number>(0);
  const lastErrorRef = useRef<unknown>(null);
  const [showOfflineHint, setShowOfflineHint] = useState(false);
  const [showRestoredHint, setShowRestoredHint] = useState(false);
  // "Mine", for conflict resolution, always means whatever is currently in
  // the editor's state at the moment the user resolves it — never a stale
  // snapshot held elsewhere — so a detected-at-load conflict applies the
  // draft into state immediately (visible, editable) but blocks the
  // auto-resync a plain "restore" would normally do, until the user picks.
  const [conflictActive, setConflictActive] = useState(false);
  const offlineWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept current every render so the save queue's onStatusChange closure
  // (created once, see saveQueueRef below) can always clear the RIGHT
  // user's/note's local draft, not whichever was current when the queue
  // was first built.
  const userRef = useRef(user);
  userRef.current = user;
  const docIdRef = useRef(docId);
  docIdRef.current = docId;

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

    const id = noteId ?? recoveredDraftId ?? makeNoteId();
    setDocId(id);

    if (!noteId && recoveredDraftId) {
      // Recovering a new note that never reached Firestore (ENMA
      // notes-durability audit, PHASE 3/recovery). There is no server
      // document to race against — nothing was ever created — so just
      // load the local draft directly and resume as a normal first save
      // (isNew stays true, so writeNote still goes through the
      // free-tier-limited entityCreate path on the next schedule()).
      getNoteDraftStore().load(user.uid, recoveredDraftId).then(draft => {
        if (draft) {
          setTitle(draft.title);
          setContent(draft.content);
          setType(draft.type);
          setChecklistItems(draft.checklistItems);
          setCategory(draft.category);
          setPinned(draft.pinned);
        }
        knownRevRef.current = 0;
        setLoaded(true);
        setTimeout(() => titleRef.current?.focus(), 80);
      });
      return;
    }

    if (noteId) {
      // Load from Firestore
      getDoc(doc(db, 'notes', noteId)).then(async snap => {
        let serverRev = 0;
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
          serverRev = typeof d.rev === 'number' ? d.rev : 0;
        }
        knownRevRef.current = serverRev;

        // ENMA notes-durability audit, PHASE 3: a draft left in IndexedDB
        // from a previous session means a write never reached Firestore
        // (a reload/crash/offline stretch interrupted it) — never silently
        // dropped, but also never applied blindly: only restore it if
        // nothing else has changed this note since the draft was taken.
        const draft = await getNoteDraftStore().load(user.uid, noteId);
        const decision = decideDraftAction(draft, serverRev);
        if (decision === 'restore' && draft) {
          setTitle(draft.title);
          setContent(draft.content);
          setType(draft.type);
          setChecklistItems(draft.checklistItems);
          setCategory(draft.category);
          setPinned(draft.pinned);
          setShowRestoredHint(true);
          if (restoredHintTimerRef.current) clearTimeout(restoredHintTimerRef.current);
          restoredHintTimerRef.current = setTimeout(() => setShowRestoredHint(false), 4000);
          // Try to resync the recovered content right away — the queue is
          // already initialized synchronously during render, before any
          // effect's async continuation (like this one) can run.
          saveQueueRef.current?.schedule({
            id: noteId, title: draft.title, content: draft.content, type: draft.type,
            checklistItems: draft.checklistItems, category: draft.category, pinned: draft.pinned,
          });
        } else if (decision === 'conflict' && draft) {
          // Something else wrote a newer revision after this draft was
          // taken. The draft is still applied into state — so the user
          // can SEE and keep editing it rather than it vanishing — but it
          // is NOT auto-scheduled for a write; that's gated behind the
          // conflict banner until the user explicitly picks a version.
          setTitle(draft.title);
          setContent(draft.content);
          setType(draft.type);
          setChecklistItems(draft.checklistItems);
          setCategory(draft.category);
          setPinned(draft.pinned);
          setConflictActive(true);
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
        // The doc has just been created with no `rev` field yet — the
        // transaction below treats a missing field as 0, so this keeps
        // the editor's own idea of the revision consistent with that.
        knownRevRef.current = 0;
        setUpdatedAt(new Date());
        return;
      }

      // Update existing note (or already-created new note on subsequent
      // auto-saves). ENMA notes-durability audit, PHASE 4: wrapped in a
      // transaction so a concurrent write from elsewhere (another tab,
      // another device, a restored-draft resync racing a live edit) is
      // detected instead of silently overwritten. `rev` is a plain
      // client-visible integer (not a locked/server-owned field — see
      // firestore.rules) that only this optimistic-concurrency check
      // relies on; a legacy document with no `rev` field is treated as
      // revision 0, so existing notes keep working without migration.
      const ref = doc(db, 'notes', id);
      let nextRev = 0;
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const serverRev = snap.exists() && typeof snap.data()?.rev === 'number' ? snap.data()!.rev : 0;
        if (knownRevRef.current !== serverRev) {
          throw new NoteConflictError(serverRev);
        }
        nextRev = serverRev + 1;
        tx.set(ref, { ...fields, userId: user.uid, updatedAt: serverTimestamp(), rev: nextRev }, { merge: true });
      });
      knownRevRef.current = nextRev;
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
      // Captures the real error (noteSaveQueue's own catch only tracks a
      // boolean) so onStatusChange below can tell "offline", "conflict"
      // and "other failure" apart, then rethrows so the queue's existing,
      // already-tested success/failure bookkeeping is untouched.
      write: (patch) => writeNoteRef.current(patch).catch((err) => {
        lastErrorRef.current = err;
        throw err;
      }),
      debounceMs: DEBOUNCE_MS,
      onStatusChange: (status) => {
        if (offlineWatchdogRef.current) {
          clearTimeout(offlineWatchdogRef.current);
          offlineWatchdogRef.current = null;
        }
        setShowOfflineHint(false);

        if (status === 'saved' && paywallHitRef.current) {
          // writeNote hit the free-plan limit and returned without
          // throwing (it's not a retryable error, the Paywall already
          // covers the UI response) — but nothing was actually written,
          // so this is not a "saved" moment. Go straight back to idle.
          paywallHitRef.current = false;
          setSavingState('idle');
          return;
        }

        if (status === 'saving') {
          // PHASE 2: this app's Firestore client has no offline
          // persistence, so a write attempted with no connectivity just
          // sits pending (resolves neither way) until the connection
          // returns — "Сохранение…" would otherwise hang forever with no
          // explanation. After a few seconds of that, tell the truth:
          // the text is safe on this device (the draft store already has
          // it), it just hasn't reached the server yet.
          offlineWatchdogRef.current = setTimeout(() => setShowOfflineHint(true), OFFLINE_HINT_MS);
        }

        if (status === 'saved') {
          // Confirmed server write — only now is it safe to drop the
          // local draft (PHASE 3, requirement 5: never clear it before a
          // confirmed success).
          const u = userRef.current;
          const id = docIdRef.current;
          if (u && id) getNoteDraftStore().clear(u.uid, id).catch(() => {});
        }

        if (status === 'error' && classifyWriteError(lastErrorRef.current) === 'conflict') {
          // A live edit raced a newer write from elsewhere (another tab/
          // device). The draft store already holds this editor's current
          // content (every change persists it), so it's safe for the
          // user to review as "mine" without anything extra — just stop
          // the queue from silently retrying the same stale comparison.
          setConflictActive(true);
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

  // Trigger save whenever editable fields change. Two independent things
  // happen on every change, not just the debounced one:
  //  1. The local draft (IndexedDB) is persisted IMMEDIATELY — this is
  //     what actually protects the "closed the tab/lost power mid-
  //     debounce" window, not the network write, which is still debounced
  //     and can still be slow/offline/failing.
  //  2. The real Firestore write is scheduled through the save queue, same
  //     as before.
  useEffect(() => {
    if (!loaded || !docId || !user) return;
    const patch: NotePatch = { id: docId, title, content, type, checklistItems, category, pinned };
    // save() never throws — it resolves to false (rather than rejecting)
    // when local storage is unavailable/full/blocked, so a degraded local
    // safety net is logged for debugging but never blocks or fails the
    // real Firestore write path scheduled right below.
    getNoteDraftStore().save({
      uid: user.uid, noteId: docId, title, content, type, checklistItems, category, pinned,
      baseRev: knownRevRef.current, savedAtLocal: Date.now(),
    }).then(ok => {
      if (!ok) console.warn('NoteEditor: local draft persist failed (storage unavailable/full) — Firestore write is unaffected');
    });
    // While a conflict banner is up, the draft above still gets refreshed
    // (so further edits during review aren't lost either), but the write
    // itself stays paused — scheduling it here would silently resolve the
    // conflict in favor of whatever's on screen before the user ever
    // chose a version. resolveKeepMine()/resolveUseTheirs() explicitly
    // schedule (or discard) once the user decides.
    if (conflictActive) return;
    saveQueueRef.current?.schedule(patch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, type, checklistItems, category, pinned, loaded, docId, user, conflictActive]);

  // Flush on unmount — the exact fix for the "edits silently lost" bug:
  // whatever's still pending gets written now instead of discarded. This
  // is a fire-and-forget (the component is gone, there's no UI left to
  // show "saving"/"saved" to) — the write itself still completes; the
  // Firestore client is a module-level singleton independent of this
  // component's lifecycle, so it isn't cancelled by the unmount either.
  useEffect(() => {
    return () => {
      if (idleResetTimer.current) clearTimeout(idleResetTimer.current);
      if (offlineWatchdogRef.current) clearTimeout(offlineWatchdogRef.current);
      if (restoredHintTimerRef.current) clearTimeout(restoredHintTimerRef.current);
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
    // A leftover local draft for a now-deleted note must never resurrect
    // it on a future load — clear it too.
    if (user) await getNoteDraftStore().clear(user.uid, docId).catch(() => {});
    onBack();
  };

  // ── Back ────────────────────────────────────────────────────────────────
  // Flushes any still-pending edit (debounced or in-flight) and waits for
  // it before navigating away — the explicit, user-facing counterpart to
  // the unmount flush above. On failure, stays on screen: the typed text
  // is untouched (local state was never cleared) and savingState shows
  // the error, so editing again naturally retries via the normal debounce.
  // An unresolved conflict also blocks navigation — the draft is already
  // safe in IndexedDB either way, but leaving silently would mean the
  // user never actually chose which version to keep.
  const handleBack = async () => {
    if (conflictActive) return;
    if (!saveQueueRef.current?.hasPendingWork()) { onBack(); return; }
    const ok = await saveQueueRef.current.flush();
    if (!ok) return;
    onBack();
  };

  // ── Conflict resolution (PHASE 4) ───────────────────────────────────────
  // Neither path merges text automatically — the user explicitly picks one
  // whole version. "Keep mine" re-bases the editor onto the current server
  // revision and resyncs; "Use theirs" reloads the server content, discards
  // the stale local draft, and keeps editing from there.
  const resolveKeepMine = async () => {
    if (!docId || !user) { setConflictActive(false); return; }
    const snap = await getDoc(doc(db, 'notes', docId));
    knownRevRef.current = snap.exists() && typeof snap.data()?.rev === 'number' ? snap.data()!.rev : 0;
    setConflictActive(false);
    saveQueueRef.current?.schedule({ id: docId, title, content, type, checklistItems, category, pinned });
  };

  const resolveUseTheirs = async () => {
    if (!docId || !user) { setConflictActive(false); return; }
    const snap = await getDoc(doc(db, 'notes', docId));
    if (snap.exists()) {
      const d = snap.data();
      setTitle(d.title ?? '');
      setContent(d.content ?? '');
      setType(d.type ?? 'text');
      setChecklistItems(d.checklistItems ?? []);
      setCategory(d.category ?? defaultCats[0]);
      setPinned(d.pinned ?? false);
      knownRevRef.current = typeof d.rev === 'number' ? d.rev : 0;
    }
    await getNoteDraftStore().clear(user.uid, docId).catch(() => {});
    setConflictActive(false);
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

      {conflictActive && (
        <div className="note-editor__conflict-banner" role="alert">
          <div className="note-editor__conflict-text">
            <strong>{t.conflictTitle}</strong>
            <span>{t.conflictBody}</span>
          </div>
          <div className="note-editor__conflict-actions">
            <button type="button" onClick={resolveKeepMine} className="note-editor__conflict-btn">
              {t.keepMine}
            </button>
            <button type="button" onClick={resolveUseTheirs} className="note-editor__conflict-btn note-editor__conflict-btn--secondary">
              {t.useTheirs}
            </button>
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="note-editor__toolbar">
        <button
          className="note-editor__back-btn"
          onClick={handleBack}
          disabled={savingState === 'saving' || conflictActive}
          type="button"
        >
          <FaArrowLeft /> {t.back}
        </button>

        <div className="note-editor__toolbar-actions" ref={menuRef}>
          {showRestoredHint && (
            <span className="note-editor__saving note-editor__saving--restored">
              {t.restoredHint}
            </span>
          )}
          {savingState === 'saving' && showOfflineHint && (
            <span className="note-editor__saving note-editor__saving--offline">
              {t.offlinePending}
            </span>
          )}
          {savingState === 'saving' && !showOfflineHint && (
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
