import {
  doc,
  getDoc,
  setDoc,
  runTransaction,
  increment,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { FREE_LIMITS } from '../subscription';

type FreeEntity = 'transaction' | 'task' | 'habit' | 'note' | 'bank';

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate  = () => new Date().toISOString().slice(0, 10);

interface FreeUsageData {
  userId: string;
  month: string;
  date: string;
  transactionCount: number;
  dailyTaskCount: number;
  habitCount: number;
  noteCount: number;
  bankCount: number;
}

interface LimitResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export async function getFreeUsage(userId: string): Promise<FreeUsageData> {
  const snap = await getDoc(doc(db, 'freeUsage', userId));
  const month = currentMonth();
  const date  = currentDate();

  if (!snap.exists()) {
    return {
      userId,
      month,
      date,
      transactionCount: 0,
      dailyTaskCount:   0,
      habitCount:       0,
      noteCount:        0,
      bankCount:        0,
    };
  }

  const d = snap.data() as Partial<FreeUsageData>;
  return {
    userId,
    month:            d.month  ?? month,
    date:             d.date   ?? date,
    transactionCount: d.month  === month ? (d.transactionCount ?? 0) : 0,
    dailyTaskCount:   d.date   === date  ? (d.dailyTaskCount   ?? 0) : 0,
    habitCount:       d.habitCount       ?? 0,
    noteCount:        d.noteCount        ?? 0,
    bankCount:        d.bankCount        ?? 0,
  };
}

export async function checkFreeLimit(
  userId: string,
  entity: FreeEntity,
): Promise<LimitResult> {
  const usage = await getFreeUsage(userId);

  switch (entity) {
    case 'transaction': {
      const limit = FREE_LIMITS.monthlyTransactions;
      return { allowed: usage.transactionCount < limit, used: usage.transactionCount, limit };
    }
    case 'task': {
      const limit = FREE_LIMITS.dailyTasks;
      return { allowed: usage.dailyTaskCount < limit, used: usage.dailyTaskCount, limit };
    }
    case 'habit': {
      const limit = FREE_LIMITS.habits;
      return { allowed: usage.habitCount < limit, used: usage.habitCount, limit };
    }
    case 'note': {
      const limit = FREE_LIMITS.notes;
      return { allowed: usage.noteCount < limit, used: usage.noteCount, limit };
    }
    case 'bank': {
      const limit = FREE_LIMITS.banks;
      return { allowed: usage.bankCount < limit, used: usage.bankCount, limit };
    }
  }
}

export async function incrementFreeUsage(
  userId: string,
  entity: FreeEntity,
  delta: 1 | -1 = 1,
): Promise<void> {
  const ref = doc(db, 'freeUsage', userId);

  if (entity === 'transaction') {
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const d    = snap.data() as Partial<FreeUsageData> | undefined;
      const month = currentMonth();
      const sameMonth = d?.month === month;
      tx.set(ref, {
        userId,
        month,
        transactionCount: (sameMonth ? (d?.transactionCount ?? 0) : 0) + delta,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
    return;
  }

  if (entity === 'task') {
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const d    = snap.data() as Partial<FreeUsageData> | undefined;
      const date = currentDate();
      const sameDay = d?.date === date;
      tx.set(ref, {
        userId,
        date,
        dailyTaskCount: (sameDay ? (d?.dailyTaskCount ?? 0) : 0) + delta,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
    return;
  }

  const fieldMap: Partial<Record<FreeEntity, string>> = {
    habit: 'habitCount',
    note:  'noteCount',
    bank:  'bankCount',
  };
  const field = fieldMap[entity];
  if (!field) return;

  await setDoc(ref, {
    userId,
    [field]: increment(delta),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}
