import {
  doc,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';

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
// subscribeFreeUsage
//
// Real-time subscription to freeUsage/{userId}. The callback receives values
// already adjusted for the current UTC time window (stale month/date → 0).
// ─────────────────────────────────────────────────────────────────────────────

export function subscribeFreeUsage(
  userId: string,
  cb: (snapshot: FreeUsageSnapshot) => void,
): Unsubscribe {
  const ref = doc(db, 'users', userId, 'freeUsage', 'counters');
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
