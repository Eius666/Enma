// Re-export all app-layer types from the canonical source.
// Workspace components import from this file unchanged; the types
// are now owned by src/types/app.ts.
export type {
  Language,
  Currency,
  Theme,
  PrimaryTab,
  CalendarTask,
  NoteBlock,
  NotePage,
  NoteProject,
  Category,
  Transaction,
  Habit,
  AppUserProfile,
  Reminder,
  FinanceSummary,
} from '../../types/app';

export { createId } from '../../types/app';
