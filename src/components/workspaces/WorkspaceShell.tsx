import React from 'react';
import { DayFlowOverview } from './DayFlowOverview';
import { CalendarWorkspace } from './CalendarWorkspace';
import { NotesWorkspace } from './NotesWorkspace';
import { HabitsWorkspace } from './HabitsWorkspace';
import { FinanceWorkspace } from './FinanceWorkspace';
import { SettingsPanel } from './SettingsPanel';
import type {
  Language,
  Currency,
  CalendarTask,
  NotePage,
  NoteProject,
  Category,
  Transaction,
  Habit,
  Reminder,
  FinanceSummary,
  PrimaryTab,
} from './types';

type WorkspaceShellProps = {
  activeTab: PrimaryTab;
  language: Language;
  currency: Currency;
  convertAmount: (amount: number) => number;
  convertToBase: (amount: number) => number;
  tasks: CalendarTask[];
  onTasksChange: (tasks: CalendarTask[]) => void;
  notes: NotePage[];
  onNotesChange: (notes: NotePage[]) => void;
  noteProjects: NoteProject[];
  onNoteProjectsChange: (projects: NoteProject[]) => void;
  categories: Category[];
  onCategoriesChange: (categories: Category[]) => void;
  transactions: Transaction[];
  onTransactionsChange: (transactions: Transaction[]) => void;
  onPersistTransaction: (transaction: Transaction) => void;
  onDeleteTransaction: (id: string) => void;
  onRefreshTransactions: () => void;
  habits: Habit[];
  onAddHabit: (name: string) => void;
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
  onDeleteHabit: (habitId: string) => void;
  reminders: Reminder[];
  upcomingReminders: Reminder[];
  onAddReminder: (date: Date, title: string, time: string, notes?: string) => void;
  onToggleReminder: (id: string) => void;
  onDeleteReminder: (id: string) => void;
  upcomingTasks: CalendarTask[];
  financeSummary: FinanceSummary;
  latestNote?: NotePage;
  ratesUpdatedAt: string | null;
  ratesStatus: 'idle' | 'loading' | 'error';
  onRefreshRates: () => void;
  onLanguageChange: (language: Language) => void;
  onCurrencyChange: (currency: Currency) => void;
};

export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({ activeTab, ...props }) => {
  switch (activeTab) {
    case 'day-flow':
      return (
        <DayFlowOverview
          language={props.language}
          currency={props.currency}
          convertAmount={props.convertAmount}
          upcomingTasks={props.upcomingTasks}
          financeSummary={props.financeSummary}
          latestNote={props.latestNote}
          reminders={props.upcomingReminders}
          onToggleReminder={props.onToggleReminder}
          habits={props.habits}
          onToggleHabitDay={props.onToggleHabitDay}
        />
      );

    case 'calendar':
      return (
        <CalendarWorkspace
          language={props.language}
          tasks={props.tasks}
          reminders={props.reminders}
          onTasksChange={props.onTasksChange}
          onAddReminder={props.onAddReminder}
          onToggleReminder={props.onToggleReminder}
          onDeleteReminder={props.onDeleteReminder}
        />
      );

    case 'notes':
      return (
        <NotesWorkspace
          language={props.language}
          notes={props.notes}
          noteProjects={props.noteProjects}
          onNotesChange={props.onNotesChange}
          onNoteProjectsChange={props.onNoteProjectsChange}
        />
      );

    case 'finance':
      return (
        <FinanceWorkspace
          language={props.language}
          currency={props.currency}
          convertAmount={props.convertAmount}
          convertToBase={props.convertToBase}
          categories={props.categories}
          onCategoriesChange={props.onCategoriesChange}
          transactions={props.transactions}
          onTransactionsChange={props.onTransactionsChange}
          onPersistTransaction={props.onPersistTransaction}
          onDeleteTransaction={props.onDeleteTransaction}
          onRefreshTransactions={props.onRefreshTransactions}
        />
      );

    case 'habits':
      return (
        <HabitsWorkspace
          language={props.language}
          habits={props.habits}
          onAddHabit={props.onAddHabit}
          onToggleHabitDay={props.onToggleHabitDay}
          onDeleteHabit={props.onDeleteHabit}
        />
      );

    case 'settings':
      return (
        <SettingsPanel
          language={props.language}
          onLanguageChange={props.onLanguageChange}
          currency={props.currency}
          onCurrencyChange={props.onCurrencyChange}
          ratesUpdatedAt={props.ratesUpdatedAt}
          ratesStatus={props.ratesStatus}
          onRefreshRates={props.onRefreshRates}
        />
      );
  }
};
