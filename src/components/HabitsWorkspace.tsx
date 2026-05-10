import React, { useState } from 'react';
import { addDays, format, startOfWeek } from 'date-fns';
import { FaPlus, FaTrash } from 'react-icons/fa';
import { translate } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { formatDate } from '../lib/utils';
import type { Habit, Language } from '../types';

type HabitsWorkspaceProps = {
  language: Language;
  habits: Habit[];
  onAddHabit: (name: string) => void;
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
  onDeleteHabit: (habitId: string) => void;
};

const HabitsWorkspace: React.FC<HabitsWorkspaceProps> = ({
  language,
  habits,
  onAddHabit,
  onToggleHabitDay,
  onDeleteHabit
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const [habitDraft, setHabitDraft] = useState('');
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekDays = Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i));
  const dayKeys = weekDays.map(d => format(d, 'yyyy-MM-dd'));

  return (
    <section className="panel habits-panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('habitBadge')}</span>
          <h2>{t('habitsWorkspaceTitle')}</h2>
          <p className="panel-subtitle">{t('habitsWorkspaceSubtitle')}</p>
        </div>
      </header>
      <div className="panel-body">
        <article className="card habit-card habit-card--compact">
          <div className="habit-card-header">
            <span className="card-badge muted">{t('habitBadge')}</span>
            <h3>{t('habitTitle')}</h3>
          </div>
          <div className="habit-add habit-add--compact">
            <input
              type="text"
              placeholder={t('habitPlaceholder')}
              value={habitDraft}
              onChange={e => setHabitDraft(e.target.value)}
            />
            <button
              className="ghost-button"
              onClick={() => {
                if (!habitDraft.trim()) return;
                onAddHabit(habitDraft);
                setHabitDraft('');
              }}
            >
              <FaPlus /> {t('addHabit')}
            </button>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">{t('habitEmptyHint')}</p>
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
                            aria-label={t('deleteHabitAria', { name: habit.title })}
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
                      {weekDays.map((day, i) => {
                        const key = dayKeys[i];
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
                            <span className="habit-day-date">{formatDate(language, day, 'd')}</span>
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

export default HabitsWorkspace;
