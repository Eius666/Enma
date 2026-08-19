import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import { FREE_LIMITS } from '../subscription';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FreeEntity = 'transaction' | 'task' | 'habit' | 'note' | 'bank';

export interface AtomicResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export interface FreeUsageSnapshot {
  dailyTaskCount:   number;
  habitCount:       number;
  noteCount:        number;
  bankCount:        number;
  transactionCount: number;
}

export interface AiUsageSnapshot {
  textRequests:  number;
  imageRequests: number;
  pdfReports:    number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (UTC — acceptable for server-side limit windows)
// ─────────────────────────────────────────────────────────────────────────────

const currentMonth = (): string => new Date().toISOString().slice(0, 7);
const currentDate  = (): string => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Entity config
// ─────────────────────────────────────────────────────────────────────────────

interface EntityConfig {
  field:        string;
  limit:        number;
  windowField?: 'month' | 'date';
}

const ENTITY_CONFIG: Record<FreeEntity, EntityConfig> = {
  transaction: { field: 'transactionCount', limit: FREE_LIMITS.monthlyTransactions, windowField: 'month' },
  task:        { field: 'dailyTaskCount',   limit: FREE_LIMITS.dailyTasks,          windowField: 'date'  },
  habit:       { field: 'habitCount',       limit: FREE_LIMITS.habits                                    },
  note:        { field: 'noteCount',        limit: FREE_LIMITS.notes                                     },
  bank:        { field: 'bankCount',        limit: FREE_LIMITS.banks                                     },
};

// ─────────────────────────────────────────────────────────────────────────────
// incrementFreeUsageAtomic
//
// Atomically reads the counter, checks the limit, and increments — all in a
// single Firestore transaction. Returns { allowed: false } WITHOUT writing if
// the limit is already reached. Firestore retries the transaction automatically
// on contention (up to 5 times).
// ─────────────────────────────────────────────────────────────────────────────

export async function incrementFreeUsageAtomic(
  userId: string,
  entity: FreeEntity,
): Promise<AtomicResult> {
  const cfg = ENTITY_CONFIG[entity];
  const ref = doc(db, 'freeUsage', userId);
  const win = cfg.windowField === 'month' ? currentMonth()
            : cfg.windowField === 'date'  ? currentDate()
            : null;

  let result: AtomicResult = { allowed: false, used: 0, limit: cfg.limit };

  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const data = (snap.data() ?? {}) as Record<string, unknown>;

    const storedWin = win !== null ? String(data[cfg.windowField!] ?? '') : null;
    const used      = (storedWin !== null && storedWin !== win)
      ? 0
      : Number(data[cfg.field] ?? 0);

    if (used >= cfg.limit) {
      result = { allowed: false, used, limit: cfg.limit };
      return;
    }

    const patch: Record<string, unknown> = {
      userId,
      [cfg.field]: used + 1,
      updatedAt: serverTimestamp(),
    };
    if (win !== null) patch[cfg.windowField!] = win;

    tx.set(ref, patch, { merge: true });
    result = { allowed: true, used: used + 1, limit: cfg.limit };
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// decrementFreeUsageAtomic
//
// Corrects the counter when a document write fails after a successful atomic
// increment. Only decrements if the stored time-window still matches, so a
// stale window reset is never double-applied.
// ─────────────────────────────────────────────────────────────────────────────

export async function decrementFreeUsageAtomic(
  userId: string,
  entity: FreeEntity,
): Promise<void> {
  const cfg = ENTITY_CONFIG[entity];
  const ref = doc(db, 'freeUsage', userId);
  const win = cfg.windowField === 'month' ? currentMonth()
            : cfg.windowField === 'date'  ? currentDate()
            : null;

  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const data = (snap.data() ?? {}) as Record<string, unknown>;

    if (win !== null) {
      const storedWin = String(data[cfg.windowField!] ?? '');
      if (storedWin !== win) return;
    }

    const current = Number(data[cfg.field] ?? 0);
    if (current <= 0) return;

    tx.set(ref, { [cfg.field]: current - 1, updatedAt: serverTimestamp() }, { merge: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// subscribeFreeUsage
//
// Real-time subscription to freeUsage/{userId}. The callback receives values
// already adjusted for the current UTC time window (stale month/date → 0).
// ─────────────────────────────────────────────────────────────────────────────

export function subscribeFreeUsage(
  userId: string,
  cb: (snapshot: FreeUsageSnapshot) => void,
): Unsubscribe {
  const ref = doc(db, 'freeUsage', userId);
  return onSnapshot(
    ref,
    snap => {
      const d     = (snap.data() ?? {}) as Record<string, unknown>;
      const month = currentMonth();
      const date  = currentDate();
      cb({
        transactionCount: String(d.month ?? '') === month ? Number(d.transactionCount ?? 0) : 0,
        dailyTaskCount:   String(d.date  ?? '') === date  ? Number(d.dailyTaskCount   ?? 0) : 0,
        habitCount:       Number(d.habitCount  ?? 0),
        noteCount:        Number(d.noteCount   ?? 0),
        bankCount:        Number(d.bankCount   ?? 0),
      });
    },
    () => cb({ transactionCount: 0, dailyTaskCount: 0, habitCount: 0, noteCount: 0, bankCount: 0 }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// subscribeAiUsage
//
// Real-time subscription to aiUsage/{userId}. Values reset to 0 when the
// stored month does not match the current UTC month.
// ─────────────────────────────────────────────────────────────────────────────

export function subscribeAiUsage(
  userId: string,
  cb: (snapshot: AiUsageSnapshot) => void,
): Unsubscribe {
  const ref = doc(db, 'aiUsage', userId);
  return onSnapshot(
    ref,
    snap => {
      const d    = (snap.data() ?? {}) as Record<string, unknown>;
      const same = String(d.month ?? '') === currentMonth();
      cb({
        textRequests:  same ? Number(d.textRequests  ?? 0) : 0,
        imageRequests: same ? Number(d.imageRequests ?? 0) : 0,
        pdfReports:    same ? Number(d.pdfReports    ?? 0) : 0,
      });
    },
    () => cb({ textRequests: 0, imageRequests: 0, pdfReports: 0 }),
  );
}
