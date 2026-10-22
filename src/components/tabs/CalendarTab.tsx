import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import CalendarView from '../CalendarView';
import DayTaskEditor from '../DayTaskEditor';
import type { DayTask } from '../../lib/dayTask';
import type { Subscription } from '../../subscription';
import type { Language } from '../../types/app';

interface Props {
  language: Language;
  user: User;
  tasks: DayTask[];
  subscription: Subscription | null;
}

// "Calendar" tab: the month view and the task editor (optionally opened on a
// chosen date). The calendar/editor state is local and resets when the tab is left.
export function CalendarTab({ language, user, tasks, subscription }: Props): React.ReactElement {
  const [view, setView] = useState<'calendar' | 'editor'>('calendar');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [preDate, setPreDate] = useState<string | null>(null);

  return (
    <>
      {view === 'calendar' && (
        <CalendarView
          language={language}
          user={user}
          tasks={tasks}
          onOpenEditor={(id, date) => {
            setActiveTaskId(id);
            setPreDate(date ?? null);
            setView('editor');
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}
        />
      )}
      {view === 'editor' && (
        <DayTaskEditor
          taskId={activeTaskId}
          initialTask={activeTaskId ? tasks.find(t => t.id === activeTaskId) ?? null : null}
          initialDate={preDate ?? undefined}
          user={user}
          language={language}
          subscription={subscription}
          onBack={() => {
            setView('calendar');
            setActiveTaskId(null);
            setPreDate(null);
          }}
        />
      )}
    </>
  );
}
