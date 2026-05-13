export type Language = 'en' | 'ru';
export type Currency = 'USD' | 'EUR' | 'GBP' | 'RUB';
export type Theme = 'dark' | 'light';
export type PrimaryTab = 'day-flow' | 'calendar' | 'notes' | 'finance' | 'habits' | 'settings';

export type CalendarTask = {
  id: string;
  title: string;
  date: string;
  color: string;
  notes?: string;
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

export type Transaction = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  description: string;
  date: string;
};

export type Habit = {
  id: string;
  title: string;
  history: Record<string, boolean>;
};

export type UserProfile = {
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

export const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
