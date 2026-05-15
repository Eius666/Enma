import React, { useState } from 'react';
import './styles/habits.css';
import { addDays, format, startOfWeek } from 'date-fns';
import { FaPlus, FaTrash } from 'react-icons/fa';
import { createT } from '../../i18n/createT';
import { formatDate } from '../../utils/formatDate';
import type { Language, Habit } from './types';

type HabitsWorkspaceProps = {
  language: Language;
  habits: Habit[];
  onAddHabit: (name: string, reminderTime?: string) => void;
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
  onDeleteHabit: (habitId: string) => void;
};

export const HabitsWorkspace: React.FC<HabitsWorkspaceProps> = ({
  language,
  habits,
  onAddHabit,
  onToggleHabitDay,
  onDeleteHabit,
}) => {
  const t = createT(language);
  const [habitDraft, setHabitDraft] = useState('');
  const [reminderTimeDraft, setReminderTimeDraft] = useState('');
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

  const handleHabitResize = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };
  const weekDays = Array.from({ length: 7 }).map((_, index) => addDays(weekStart, index));
  const dayKeys = weekDays.map(day => format(day, 'yyyy-MM-dd'));

  return (
    <section className="panel habits-panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('habits.badge')}</span>
          <h2>{t('habits.workspaceTitle')}</h2>
          <p className="panel-subtitle">{t('habits.workspaceSubtitle')}</p>
        </div>
      </header>
      <div className="panel-body">
        <article className="card habit-card habit-card--compact">
          <div className="habit-add habit-add--compact">
            <textarea
              className="habit-input"
              rows={1}
              placeholder={t('habits.placeholder')}
              value={habitDraft}
              onChange={event => setHabitDraft(event.target.value)}
              onInput={handleHabitResize}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (habitDraft.trim()) {
                    onAddHabit(habitDraft, reminderTimeDraft || undefined);
                    setHabitDraft('');
                    setReminderTimeDraft('');
                  }
                }
              }}
            />
            <input
              type="time"
              className="habit-input"
              style={{ minWidth: 0, flex: '0 0 auto', width: 'auto' }}
              value={reminderTimeDraft}
              onChange={event => setReminderTimeDraft(event.target.value)}
              title={t('habits.reminderTimeLabel')}
            />
            <button
              className="ghost-button"
              onClick={() => {
                if (!habitDraft.trim()) return;
                onAddHabit(habitDraft, reminderTimeDraft || undefined);
                setHabitDraft('');
                setReminderTimeDraft('');
              }}
            >
              <FaPlus /> {t('habits.add')}
            </button>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">{t('habits.emptyHint')}</p>
          ) : (
            <div className="habit-list">
              {habits.map(habit => {
                const completedCount = dayKeys.filter(key => habit.history[key]).length;
                const progress = Math.round((completedCount / dayKeys.length) * 100);
                return (
                  <div key={habit.id} className="habit-row">
                    <div className="habit-title">
                      <div className="habit-title-row">
                        <strong>{habit.title}</strong>
                        <div className="habit-title-actions">
                          <span className="habit-progress-label">{progress}%</span>
                          <button
                            type="button"
                            className="habit-delete"
                            onClick={() => onDeleteHabit(habit.id)}
                            aria-label={t('habits.deleteAria', { name: habit.title })}
                          >
                            <FaTrash />
                          </button>
                        </div>
                      </div>
                      <div className="habit-progress">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                    <div className="habit-days">
                      {weekDays.map((day, index) => {
                        const key = dayKeys[index];
                        const isDone = habit.history[key];
                        return (
                          <button
                            key={key}
                            className={`habit-day ${isDone ? 'is-done' : ''}`}
                            onClick={() => onToggleHabitDay(habit.id, key)}
                          >
                            <span className="habit-day-name">
                              {formatDate(language, day, 'EEE')[0]}
                            </span>
                            <span className="habit-day-date">
                              {formatDate(language, day, 'd')}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </div>
    </section>
  );
};
