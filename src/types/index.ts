export type { UserProfile } from './user';
export type { WorkspaceType, Workspace } from './workspace';
export type { Currency, FinanceTransaction, FinanceSummary } from './finance';
export type { Habit, HabitLog } from './habit';
export type { Note } from './note';
export type { Goal } from './goal';

export interface AiUsage {
  userId: string;
  month: string;
  textRequests: number;
  imageRequests: number;
  pdfReports: number;
}

export interface FreeUsage {
  userId: string;
  month: string;
  transactionCount: number;
  dailyTaskCount: number;
  dailyTaskDate: string;
}
