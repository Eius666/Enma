// App-layer types: shapes used by App.tsx and workspace components.
// These are the client-side / localStorage data models, distinct from
// the Firestore-backed types in src/types/{habit,note,goal,...}.ts.

export type Language = 'en' | 'ru';

// Canonical currency set — BYN and CNY replace the legacy GBP.
export type Currency = 'RUB' | 'USD' | 'EUR' | 'BYN' | 'CNY';

export type Theme = 'dark' | 'light';

export type PrimaryTab =
  | 'day-flow'
  | 'calendar'
  | 'notes'
  | 'finance'
  | 'habits'
  | 'settings';

export type CalendarTask = {
  id: string;
  title: string;
  date: string;
  color: string;
  notes?: string;
  deadline?: string;
  notifyBefore?: number;
};

export type NoteBlock = {
  id: string;
  type: 'paragraph' | 'todo';
  content: string;
  checked?: boolean;
};

export type NotePage = {
  id: string;
  title: string;
  blocks: NoteBlock[];
  updatedAt: string;
  noteType: 'text' | 'checklist';
  projectId?: string;
};

export type NoteProject = {
  id: string;
  name: string;
};

export type Category = {
  id: string;
  name: string;
  type: 'income' | 'expense';
};

// Client-side transaction shape (localStorage / App.tsx state).
// The server/Firestore shape lives in src/types/finance.ts.
export type Transaction = {
  id: string;
  type: 'income' | 'expense';
  // Stored in the transaction's own currency (see `currency` field).
  // Legacy records without a `currency` field must be resolved via
  // resolveLegacyCurrency() — never guessed as a blanket RUB default. See
  // src/utils/resolveLegacyCurrency.ts for the historical write-path evidence.
  // Never apply convertToBase() before storing — amount is always the user-entered value.
  amount: number;
  // Currency in which the amount is expressed. Absent for legacy records.
  currency?: Currency;
  categoryId: string;
  description: string;
  date: string;
  // Set by new FinanceEditor – human-readable "🛒 Groceries" string.
  // Legacy transactions populated via categoryId lookup instead.
  category?: string;
  // Set by Telegram bot — original amount before any conversion (kept for historical compat).
  originalAmount?: number;
  // Set by Telegram bot — user's selected currency at recording time.
  originalCurrency?: Currency;
  // 'telegram-bot' for transactions created via Telegram chat; 'ai-chat' for web AI.
  source?: string;
  // Firestore server timestamp of doc creation — used by resolveLegacyCurrency
  // to place legacy (currency-less) records relative to the USD-bug window.
  createdAt?: { toMillis?: () => number; toDate?: () => Date } | number | null;
  // Bank / payment method (e.g. "Тинькофф", "Наличные"). Optional.
  bank?: string;
  // schemaVersion 2: `rubAmount` is the ruble value LOCKED at creation time
  // and `fx` the snapshot it was computed from (null for RUB). The client
  // never writes these — the server decides them.
  schemaVersion?: number;
  rubAmount?: number;
  fx?: {
    rateToRub: number;
    source: 'bank_average' | 'official_fallback' | 'market_fallback' | string;
    provider?: string;
    capturedAt?: string;
    method?: string;
    sampleSize?: number;
    rateSide?: string;
    rateDate?: string;
  } | null;
};

// Client-side habit shape: history keyed by YYYY-MM-DD date strings.
// The Firestore-backed habit shape lives in src/types/habit.ts.
export type Habit = {
  id: string;
  title: string;
  history: Record<string, boolean>;
  reminderTime?: string;
};

// Minimal user profile stored in localStorage.
export type AppUserProfile = {
  displayName: string;
};

export type Reminder = {
  id: string;
  title: string;
  date: string;
  time: string;
  notes?: string;
  done: boolean;
  notified?: boolean;
};

export type FinanceSummary = {
  income: number;
  expenses: number;
  balance: number;
};

export const createId = (): string =>
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;
