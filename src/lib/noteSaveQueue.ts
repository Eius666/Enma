// Debounced, race-safe, flush-able save controller — originally built to
// fix NoteEditor's "notes stop saving" bug, written generic enough to
// reuse for any debounced-autosave editor.
//
// Two independent problems, one controller:
//
// 1. STALE-WRITE RACE (ENMA notes audit, PHASE 7): a debounce timer only
//    cancels a write that hasn't FIRED yet. Once it's fired and its network
//    call is in flight, a later edit's debounce timer can ALSO fire and
//    finish FIRST (faster request, or the earlier one was just slow) —
//    the earlier, now-stale write then lands last and overwrites the
//    newer content with old content. Fixed by never allowing two writes
//    in flight at once: a write requested while one is already running is
//    coalesced into "whatever the latest payload is once this one
//    finishes" — writes always commit in REQUEST order, never out of it.
//
// 2. SILENT LOSS ON NAVIGATE AWAY: the previous NoteEditor cleared its
//    debounce timer on unmount instead of flushing it — any edit made
//    within the debounce window right before navigating away (back
//    button, switching tabs, closing the app) was simply never written,
//    with no error, no warning, nothing. flush() exists specifically so a
//    caller can, on unmount/navigate-away, submit whatever's still pending
//    immediately and (optionally) await its outcome.

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface NoteSaveQueueOptions<T> {
  /** Performs the actual write. Throwing (or rejecting) means failure. */
  write: (payload: T) => Promise<void>;
  /** Called whenever the externally-visible status changes. */
  onStatusChange?: (status: SaveStatus) => void;
  /** Debounce delay in ms before an edit is submitted to the write queue. */
  debounceMs?: number;
}

export interface NoteSaveQueue<T> {
  /** Debounced: (re)schedules `payload` to be written after the debounce delay. */
  schedule: (payload: T) => void;
  /**
   * Cancels any pending debounce timer and submits its payload immediately,
   * then waits for that write (and anything already in flight ahead of it)
   * to fully settle. Returns true on success, false on failure. Safe to
   * call with nothing pending — resolves true immediately in that case.
   */
  flush: () => Promise<boolean>;
  /** True if there is unwritten work: a pending debounce, a write in
   *  flight, or a write queued behind one in flight. */
  hasPendingWork: () => boolean;
  /** Clears the debounce timer only — does not touch any write already
   *  submitted to the queue (those cannot be cancelled once started). */
  cancelPendingDebounce: () => void;
  /**
   * Discards any pending (unfired) debounce WITHOUT writing it, then waits
   * for anything already in flight to finish. For deleting the note: a
   * flush() here would be wrong — it would write stale content into a
   * document about to be removed, effectively resurrecting it right after
   * delete (setDoc(..., {merge:true}) silently recreates a missing doc).
   * cancelAndWait() guarantees the delete is the last word: nothing pending
   * survives to write afterward, and anything already mid-flight is
   * allowed to finish BEFORE the delete runs, so it can never land after.
   */
  cancelAndWait: () => Promise<void>;
}

export function createNoteSaveQueue<T>(options: NoteSaveQueueOptions<T>): NoteSaveQueue<T> {
  const { write, onStatusChange, debounceMs = 500 } = options;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debouncedPayload: T | null = null;

  let inFlight = false;
  let queuedPayload: T | null = null;
  let currentPromise: Promise<boolean> | null = null;

  function setStatus(s: SaveStatus) {
    onStatusChange?.(s);
  }

  // Submits `payload` to the write queue. If something is already in
  // flight, `payload` is coalesced as "the next thing to write once the
  // current write finishes" — never runs concurrently with it.
  function submit(payload: T): Promise<boolean> {
    if (inFlight) {
      queuedPayload = payload;
      return currentPromise ?? Promise.resolve(true);
    }

    inFlight = true;
    setStatus('saving');

    const promise: Promise<boolean> = (async () => {
      let ok = true;
      try {
        await write(payload);
      } catch {
        ok = false;
      } finally {
        inFlight = false;
      }

      if (queuedPayload !== null) {
        const next = queuedPayload;
        queuedPayload = null;
        // Chain the coalesced write; it decides the FINAL reported status.
        return submit(next);
      }

      setStatus(ok ? 'saved' : 'error');
      return ok;
    })();

    currentPromise = promise;
    return promise;
  }

  function cancelPendingDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    debouncedPayload = null;
  }

  function schedule(payload: T) {
    debouncedPayload = payload;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const p = debouncedPayload;
      debouncedPayload = null;
      if (p !== null) submit(p);
    }, debounceMs);
  }

  async function flush(): Promise<boolean> {
    cancelPendingDebounceKeepingPayload();
    const pending = debouncedPayload;
    debouncedPayload = null;
    if (pending !== null) {
      return submit(pending);
    }
    if (currentPromise) return currentPromise;
    return true;
  }

  // Internal: clears the TIMER only (keeps `debouncedPayload` so flush()
  // can still read it) — cancelPendingDebounce() clears both.
  function cancelPendingDebounceKeepingPayload() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function hasPendingWork(): boolean {
    return debounceTimer !== null || inFlight || queuedPayload !== null;
  }

  async function cancelAndWait(): Promise<void> {
    cancelPendingDebounce();
    if (currentPromise) await currentPromise;
  }

  return { schedule, flush, hasPendingWork, cancelPendingDebounce, cancelAndWait };
}
