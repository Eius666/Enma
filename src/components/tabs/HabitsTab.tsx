import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import HabitsList, { HabitDoc } from '../HabitsList';
import HabitEditor from '../HabitEditor';
import GoalsList from '../GoalsList';
import type { Subscription } from '../../subscription';
import type { Language } from '../../types/app';

export type HabitsSection = 'habits' | 'goals';

interface Props {
  language: Language;
  user: User;
  habits: HabitDoc[];
  subscription: Subscription | null;
  /** Kept by the parent: the Habits/Goals choice survives leaving the tab. */
  section: HabitsSection;
  onSectionChange: (section: HabitsSection) => void;
}

// "Habits" tab: the Habits/Goals switch, the habit list, the goals list and the
// habit editor. The list/editor state is local and resets when the tab is left.
export function HabitsTab({ language, user, habits, subscription, section, onSectionChange }: Props): React.ReactElement {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [activeHabitId, setActiveHabitId] = useState<string | null>(null);

  return (
    <>
      {view === 'list' && (
        <div className="fin-list__period-wrap" role="tablist">
          <button
            type="button"
            className={`fin-list__period-chip${section === 'habits' ? ' fin-list__period-chip--active' : ''}`}
            onClick={() => onSectionChange('habits')}
          >
            {language === 'ru' ? 'Привычки' : 'Habits'}
          </button>
          <button
            type="button"
            className={`fin-list__period-chip${section === 'goals' ? ' fin-list__period-chip--active' : ''}`}
            onClick={() => onSectionChange('goals')}
          >
            {language === 'ru' ? 'Цели' : 'Goals'}
          </button>
        </div>
      )}
      {view === 'list' && section === 'goals' && (
        <GoalsList user={user} language={language} />
      )}
      {view === 'list' && section === 'habits' && (
        <HabitsList
          language={language}
          user={user}
          habits={habits}
          onOpenEditor={(id) => {
            setActiveHabitId(id);
            setView('editor');
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}
        />
      )}
      {view === 'editor' && (
        <HabitEditor
          habitId={activeHabitId}
          initialHabit={activeHabitId ? habits.find(h => h.id === activeHabitId) ?? null : null}
          user={user}
          language={language}
          subscription={subscription}
          onBack={() => {
            setView('list');
            setActiveHabitId(null);
          }}
        />
      )}
    </>
  );
}
