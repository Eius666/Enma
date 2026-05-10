import React, { useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { translate, getNumberLocale } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { formatDate } from '../lib/utils';
import type { CalendarTask, Currency, Habit, Language, NotePage, Reminder } from '../types';

type DayFlowOverviewProps = {
  language: Language;
  currency: Currency;
  convertAmount: (amount: number) => number;
  upcomingTasks: CalendarTask[];
  financeSummary: { income: number; expenses: number; balance: number };
  latestNote?: NotePage;
  reminders: Reminder[];
  onToggleReminder: (id: string) => void;
  habits: Habit[];
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
};

const DayFlowOverview: React.FC<DayFlowOverviewProps> = ({
  language,
  currency,
  convertAmount,
  upcomingTasks,
  financeSummary,
  latestNote,
  reminders,
  onToggleReminder,
  habits,
  onToggleHabitDay
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const formatCurrency = (amount: number) =>
    convertAmount(amount).toLocaleString(getNumberLocale(language), { style: 'currency', currency });

  const reminderPreview = useMemo(() => reminders.slice(0, 4), [reminders]);
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const todayLabel = formatDate(language, new Date(), 'EEEE, MMM d');

  return (
    <section className="panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('dayFlowBadge')}</span>
          <h2>{t('dayFlowTitle')}</h2>
          <p className="panel-subtitle">
            {t('dayFlowSubtitle')} <span className="ui-version">UI v4.3</span>
          </p>
        </div>
      </header>

      <div className="overview-grid">
        <article className="card card-forecast">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('upcomingFocus')}</span>
              {upcomingTasks.length > 0 ? (
                <h3>
                  {t('nextLabel')} {upcomingTasks[0].title}{' '}
                  <span className="accent">
                    {formatDate(language, parseISO(upcomingTasks[0].date), 'MMM d • h:mm a')}
                  </span>
                </h3>
              ) : (
                <h3>{t('caughtUp')}</h3>
              )}
            </div>
          </div>
          <div className="card-row upcoming-list">
            {upcomingTasks.length === 0 && (
              <p className="card-row__meta">{t('addTasksHint')}</p>
            )}
            {upcomingTasks.map(task => (
              <div key={task.id} className="upcoming-item">
                <span className="upcoming-dot" style={{ backgroundColor: task.color }} />
                <div className="upcoming-info">
                  <p className="card-row__title">{task.title}</p>
                  <span className="card-row__meta">
                    {formatDate(language, parseISO(task.date), 'EEEE, MMM d · h:mm a')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="card card-timeline">
          <header className="card-heading">
            <div>
              <span className="card-badge muted">{t('financialSnapshot')}</span>
              <h3>
                {t('balanceLine', {
                  balance: formatCurrency(financeSummary.balance),
                  income: formatCurrency(financeSummary.income),
                  expenses: formatCurrency(financeSummary.expenses)
                })}
              </h3>
            </div>
          </header>
          <div className="finance-glance">
            <div className="glance-tile">
              <span className="tile-label">{t('incomeLabel')}</span>
              <span className="tile-value positive">{formatCurrency(financeSummary.income)}</span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">{t('expensesLabel')}</span>
              <span className="tile-value negative">-{formatCurrency(financeSummary.expenses)}</span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">{t('netFlowLabel')}</span>
              <span className="tile-value">{formatCurrency(financeSummary.balance)}</span>
            </div>
          </div>
        </article>

        <article className="card card-presets">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('latestNoteBadge')}</span>
              <h3>{latestNote ? latestNote.title : t('latestNoteEmptyTitle')}</h3>
            </div>
          </div>
          {latestNote ? (
            <div className="note-preview">
              {latestNote.blocks.slice(0, 3).map(block => (
                <p key={block.id} className="note-preview-line">
                  {block.type === 'todo' ? '☐ ' : ''}
                  {block.content}
                </p>
              ))}
              <span className="card-row__meta">
                {t('latestNoteUpdated', {
                  date: formatDate(language, parseISO(latestNote.updatedAt), 'MMM d, h:mm a')
                })}
              </span>
            </div>
          ) : (
            <p className="card-row__meta">{t('latestNoteEmptyHint')}</p>
          )}
        </article>

        <article className="card card-reminders">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('remindersBadge')}</span>
              <h3>{t('remindersTitle')}</h3>
            </div>
          </div>
          {reminderPreview.length === 0 ? (
            <p className="card-row__meta">{t('remindersEmptyHint')}</p>
          ) : (
            <div className="reminder-preview">
              {reminderPreview.map(reminder => (
                <div key={reminder.id} className="reminder-preview-item">
                  <div>
                    <p className="card-row__title">{reminder.title}</p>
                    <span className="card-row__meta">
                      {formatDate(language, parseISO(reminder.date), 'MMM d')} · {reminder.time}
                    </span>
                    {reminder.notes && (
                      <span className="card-row__meta reminder-note">{reminder.notes}</span>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={reminder.done}
                    onChange={() => onToggleReminder(reminder.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </article>

        <article
          className={`card habit-card habit-card--compact habit-checkin ${habits.length === 0 ? 'is-empty' : ''}`}
        >
          <div className="habit-card-header">
            <span className="card-badge muted">{t('habitBadge')}</span>
            <h3>{t('habitCheckinTitle')}</h3>
            <p className="card-row__meta habit-subtitle">{t('habitCheckinSubtitle')}</p>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">{t('habitCheckinEmpty')}</p>
          ) : (
            <div className="habit-checkin-list">
              {habits.map(habit => {
                const isDone = habit.history[todayKey];
                return (
                  <div key={habit.id} className="habit-checkin-row">
                    <div className="habit-checkin-info">
                      <strong>{habit.title}</strong>
                      <span className="card-row__meta">{todayLabel}</span>
                    </div>
                    <button
                      className={`habit-checkin-toggle ${isDone ? 'is-done' : ''}`}
                      onClick={() => onToggleHabitDay(habit.id, todayKey)}
                      type="button"
                    >
                      {isDone ? '✓' : '○'}
                    </button>
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

export default DayFlowOverview;
