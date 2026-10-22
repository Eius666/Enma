import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import DayList from '../DayList';
import DayTaskEditor from '../DayTaskEditor';
import OnboardingDemo from '../OnboardingDemo';
import InsightsFeed from '../InsightsFeed';
import type { InsightAction } from '../InsightsFeed';
import type { DayTask } from '../../lib/dayTask';
import type { Subscription } from '../../subscription';
import type { Language } from '../../types/app';

type DayListProps = React.ComponentProps<typeof DayList>;

interface Props {
  language: Language;
  user: User;
  currency: string;
  rates: Record<string, number>;
  firestoreHabits: DayListProps['firestoreHabits'];
  transactions: DayListProps['transactions'];
  tasks: DayTask[];
  subscription: Subscription | null;
  showOnboarding: boolean;
  trialActivating: boolean;
  onStartTrial: () => void;
  onDismissOnboarding: () => void;
  onInsightCta: (action: InsightAction) => void;
}

// "Day" tab: onboarding (new users), insights, today's list and the task
// editor. The list/editor state is local, so it resets whenever the tab is left.
export function DayTab({
  language, user, currency, rates, firestoreHabits, transactions, tasks, subscription,
  showOnboarding, trialActivating, onStartTrial, onDismissOnboarding, onInsightCta,
}: Props): React.ReactElement {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  return (
    <>
      {view === 'list' && showOnboarding && (
        <OnboardingDemo
          language={language}
          onStartTrial={onStartTrial}
          onDismiss={onDismissOnboarding}
          trialLoading={trialActivating}
        />
      )}
      {view === 'list' && (
        <InsightsFeed
          user={user}
          language={language}
          maxVisible={3}
          onCta={onInsightCta}
        />
      )}
      {view === 'list' && (
        <DayList
          language={language}
          user={user}
          currency={currency}
          rates={rates}
          firestoreHabits={firestoreHabits}
          transactions={transactions}
          tasks={tasks}
          onOpenEditor={(id) => {
            setActiveTaskId(id);
            setView('editor');
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}
        />
      )}
      {view === 'editor' && (
        <DayTaskEditor
          taskId={activeTaskId}
          initialTask={activeTaskId ? tasks.find(t => t.id === activeTaskId) ?? null : null}
          user={user}
          language={language}
          subscription={subscription}
          onBack={() => {
            setView('list');
            setActiveTaskId(null);
          }}
        />
      )}
    </>
  );
}
