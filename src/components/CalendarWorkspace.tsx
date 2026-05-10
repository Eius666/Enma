import React, { useMemo, useState } from 'react';
import {
  addDays,
  addMonths,
  compareAsc,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  parseISO,
  setHours,
  setMinutes,
  startOfMonth,
  startOfWeek,
  subMonths
} from 'date-fns';
import { FaArrowLeft, FaArrowRight, FaPlus, FaTrash } from 'react-icons/fa';
import { translate } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { createId, formatDate, taskColorPalette } from '../lib/utils';
import type { CalendarTask, Language, Reminder } from '../types';

type CalendarWorkspaceProps = {
  language: Language;
  tasks: CalendarTask[];
  reminders: Reminder[];
  onTasksChange: (tasks: CalendarTask[]) => void;
  onAddReminder: (date: Date, title: string, time: string, notes?: string) => void;
  onToggleReminder: (id: string) => void;
  onDeleteReminder: (id: string) => void;
};

const CalendarWorkspace: React.FC<CalendarWorkspaceProps> = ({
  language,
  tasks,
  reminders,
  onTasksChange,
  onAddReminder,
  onToggleReminder,
  onDeleteReminder
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [selectedColor, setSelectedColor] = useState(taskColorPalette[0]);
  const [draftTime, setDraftTime] = useState('09:00');
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderTime, setReminderTime] = useState('09:00');
  const [reminderNotes, setReminderNotes] = useState('');

  const tasksForSelectedDay = useMemo(
    () =>
      tasks
        .filter(task => isSameDay(parseISO(task.date), selectedDate))
        .sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date))),
    [tasks, selectedDate]
  );

  const remindersForSelectedDay = useMemo(
    () => reminders.filter(r => isSameDay(parseISO(r.date), selectedDate)),
    [reminders, selectedDate]
  );

  const addTask = () => {
    if (!draftTitle.trim()) return;
    const [hourStr, minuteStr] = draftTime.split(':');
    const dateWithTime = setMinutes(
      setHours(new Date(selectedDate), Number(hourStr) || 0),
      Number(minuteStr) || 0
    );
    const newTask: CalendarTask = {
      id: createId(),
      title: draftTitle.trim(),
      date: dateWithTime.toISOString(),
      color: selectedColor,
      notes: draftNotes.trim() || undefined
    };
    onTasksChange([...tasks, newTask]);
    setDraftTitle('');
    setDraftNotes('');
    setDraftTime('09:00');
  };

  const handleAddReminder = () => {
    if (!reminderTitle.trim()) return;
    onAddReminder(selectedDate, reminderTitle, reminderTime, reminderNotes);
    setReminderTitle('');
    setReminderNotes('');
  };

  const deleteTask = (id: string) => onTasksChange(tasks.filter(task => task.id !== id));

  const startDate = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
  const endDate = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
  const calendarCells: Date[] = [];
  let day = startDate;
  while (day <= endDate) {
    calendarCells.push(day);
    day = addDays(day, 1);
  }

  return (
    <section className="panel calendar-panel">
      <header className="panel-header calendar-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('calendarBadge')}</span>
          <h2>{formatDate(language, currentDate, 'MMMM yyyy')}</h2>
        </div>
        <div className="panel-controls">
          <button className="pill-control" onClick={() => setCurrentDate(subMonths(currentDate, 1))}>
            <FaArrowLeft />
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(new Date())}>
            {t('todayButton')}
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(addMonths(currentDate, 1))}>
            <FaArrowRight />
          </button>
        </div>
      </header>

      <div className="calendar-content">
        <div className="calendar-grid">
          {(['weekdayMon', 'weekdayTue', 'weekdayWed', 'weekdayThu', 'weekdayFri', 'weekdaySat', 'weekdaySun'] as TranslationKey[]).map(key => (
            <div key={key} className="calendar-weekday">{t(key)}</div>
          ))}
          {calendarCells.map(cellDate => {
            const dayTasks = tasks.filter(task => isSameDay(parseISO(task.date), cellDate)).slice(0, 2);
            const totalForDay = tasks.filter(task => isSameDay(parseISO(task.date), cellDate)).length;
            return (
              <button
                key={cellDate.toISOString()}
                className={[
                  'calendar-cell',
                  isSameMonth(cellDate, currentDate) ? '' : 'is-faded',
                  isSameDay(cellDate, selectedDate) ? 'is-selected' : '',
                  isSameDay(cellDate, new Date()) ? 'is-today' : ''
                ].join(' ')}
                onClick={() => setSelectedDate(cellDate)}
              >
                <span className="calendar-date">{formatDate(language, cellDate, 'd')}</span>
                <div className="calendar-badges">
                  {dayTasks.map(task => (
                    <span
                      key={task.id}
                      className="calendar-badge"
                      style={{ backgroundColor: task.color }}
                      title={task.title}
                    >
                      {task.title}
                    </span>
                  ))}
                  {dayTasks.length < totalForDay && (
                    <span className="calendar-more">{t('calendarMore')}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <aside className="calendar-sidebar">
          <div className="sidebar-card">
            <h3>{formatDate(language, selectedDate, 'EEEE, MMMM d')}</h3>
            <div className="color-palette">
              {taskColorPalette.map(color => (
                <button
                  key={color}
                  style={{ backgroundColor: color }}
                  className={`color-swatch ${selectedColor === color ? 'is-selected' : ''}`}
                  onClick={() => setSelectedColor(color)}
                />
              ))}
            </div>
            <label className="floating-label">
              <span>{t('taskTitleLabel')}</span>
              <input
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                placeholder={t('taskTitlePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('notesLabel')}</span>
              <textarea
                rows={3}
                value={draftNotes}
                onChange={e => setDraftNotes(e.target.value)}
                placeholder={t('taskNotesPlaceholder')}
              />
            </label>
            <label className="floating-label calendar-time-field">
              <span>{t('timeLabel')}</span>
              <input type="time" value={draftTime} onChange={e => setDraftTime(e.target.value)} />
            </label>
            <button className="primary-button add-task" onClick={addTask}>
              <FaPlus /> {t('addTask')}
            </button>
          </div>

          <div className="sidebar-card task-list-card">
            <h4>{t('scheduleTitle')}</h4>
            {tasksForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('noTasksForDay')}</p>
            ) : (
              <ul className="task-list">
                {tasksForSelectedDay.map(task => (
                  <li key={task.id} className="task-list-item">
                    <span className="task-dot" style={{ backgroundColor: task.color }} />
                    <div className="task-info">
                      <span className="task-title">{task.title}</span>
                      {task.notes && <span className="task-note">{task.notes}</span>}
                      <span className="task-time">
                        {formatDate(language, parseISO(task.date), 'h:mm a')}
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => deleteTask(task.id)}
                      aria-label={t('deleteTaskAria')}
                    >
                      <FaTrash />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sidebar-card reminder-card">
            <h4>{t('remindersBadge')}</h4>
            <div className="reminder-form">
              <label className="floating-label">
                <span>{t('reminderLabel')}</span>
                <input
                  value={reminderTitle}
                  onChange={e => setReminderTitle(e.target.value)}
                  placeholder={t('reminderPlaceholder')}
                />
              </label>
              <div className="reminder-time-row">
                <label className="floating-label">
                  <span>{t('timeLabel')}</span>
                  <input
                    type="time"
                    value={reminderTime}
                    onChange={e => setReminderTime(e.target.value)}
                  />
                </label>
                <button className="primary-button add-reminder-btn" onClick={handleAddReminder}>
                  <FaPlus />
                </button>
              </div>
              <label className="floating-label">
                <span>{t('notesLabel')}</span>
                <textarea
                  rows={2}
                  value={reminderNotes}
                  onChange={e => setReminderNotes(e.target.value)}
                  placeholder={t('reminderNotesPlaceholder')}
                />
              </label>
            </div>
            {remindersForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('noRemindersForDay')}</p>
            ) : (
              <ul className="reminder-list">
                {remindersForSelectedDay.map(reminder => (
                  <li key={reminder.id} className={`reminder-item ${reminder.done ? 'is-done' : ''}`}>
                    <div className="reminder-info">
                      <span className="reminder-title">{reminder.title}</span>
                      <span className="reminder-meta">
                        {formatDate(language, parseISO(reminder.date), 'MMM d')} · {reminder.time}
                      </span>
                      {reminder.notes && (
                        <span className="reminder-meta">{reminder.notes}</span>
                      )}
                    </div>
                    <div className="reminder-actions">
                      <input
                        type="checkbox"
                        checked={reminder.done}
                        onChange={() => onToggleReminder(reminder.id)}
                        aria-label={t('toggleReminderAria')}
                      />
                      <button
                        className="icon-button"
                        onClick={() => onDeleteReminder(reminder.id)}
                        aria-label={t('deleteReminderAria')}
                      >
                        <FaTrash />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
};

export default CalendarWorkspace;
