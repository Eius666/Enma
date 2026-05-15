import React, { useMemo, useState } from 'react';
import './styles/calendar.css';
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
  subMonths,
} from 'date-fns';
import { FaArrowLeft, FaArrowRight, FaPlus, FaTrash } from 'react-icons/fa';
import { createT } from '../../i18n/createT';
import { formatDate } from '../../utils/formatDate';
import { TASK_COLOR_PALETTE } from '../../constants';
import { createId } from './types';
import type { Language, CalendarTask, Reminder } from './types';

type CalendarWorkspaceProps = {
  language: Language;
  tasks: CalendarTask[];
  reminders: Reminder[];
  onTasksChange: (tasks: CalendarTask[]) => void;
  onAddReminder: (date: Date, title: string, time: string, notes?: string) => void;
  onToggleReminder: (id: string) => void;
  onDeleteReminder: (id: string) => void;
  onTaskAdded?: (task: CalendarTask) => void;
  onTaskDeleted?: (id: string) => void;
};

export const CalendarWorkspace: React.FC<CalendarWorkspaceProps> = ({
  language,
  tasks,
  reminders,
  onTasksChange,
  onAddReminder,
  onToggleReminder,
  onDeleteReminder,
  onTaskAdded,
  onTaskDeleted,
}) => {
  const t = createT(language);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [selectedColor, setSelectedColor] = useState(TASK_COLOR_PALETTE[0]);
  const [draftTime, setDraftTime] = useState('09:00');
  const [draftDeadlineTime, setDraftDeadlineTime] = useState('');
  const [draftNotifyBefore, setDraftNotifyBefore] = useState(15);
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
    () => reminders.filter(reminder => isSameDay(parseISO(reminder.date), selectedDate)),
    [reminders, selectedDate]
  );

  const addTask = () => {
    if (!draftTitle.trim()) return;
    const [hourStr, minuteStr] = draftTime.split(':');
    const dateWithTime = setMinutes(
      setHours(new Date(selectedDate), Number(hourStr) || 0),
      Number(minuteStr) || 0
    );
    let deadline: string | undefined;
    if (draftDeadlineTime) {
      const [dh, dm] = draftDeadlineTime.split(':');
      deadline = setMinutes(
        setHours(new Date(selectedDate), Number(dh) || 0),
        Number(dm) || 0
      ).toISOString();
    }
    const newTask: CalendarTask = {
      id: createId(),
      title: draftTitle.trim(),
      date: dateWithTime.toISOString(),
      color: selectedColor,
      notes: draftNotes.trim() || undefined,
      deadline,
      notifyBefore: deadline ? draftNotifyBefore : undefined,
    };
    onTasksChange([...tasks, newTask]);
    if (newTask.deadline) onTaskAdded?.(newTask);
    setDraftTitle('');
    setDraftNotes('');
    setDraftTime('09:00');
    setDraftDeadlineTime('');
    setDraftNotifyBefore(15);
  };

  const handleAddReminder = () => {
    if (!reminderTitle.trim()) return;
    onAddReminder(selectedDate, reminderTitle, reminderTime, reminderNotes);
    setReminderTitle('');
    setReminderNotes('');
  };

  const deleteTask = (id: string) => {
    const taskToDelete = tasks.find(task => task.id === id);
    onTasksChange(tasks.filter(task => task.id !== id));
    if (taskToDelete?.deadline) onTaskDeleted?.(id);
  };

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
          <span className="panel-badge">{t('calendar.badge')}</span>
          <h2>{formatDate(language, currentDate, 'MMMM yyyy')}</h2>
        </div>
        <div className="panel-controls">
          <button className="pill-control" onClick={() => setCurrentDate(subMonths(currentDate, 1))}>
            <FaArrowLeft />
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(new Date())}>
            {t('calendar.today')}
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(addMonths(currentDate, 1))}>
            <FaArrowRight />
          </button>
        </div>
      </header>

      <div className="calendar-content">
        <div className="calendar-grid">
          <div className="calendar-weekday">{t('calendar.weekdays.mon')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.tue')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.wed')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.thu')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.fri')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.sat')}</div>
          <div className="calendar-weekday">{t('calendar.weekdays.sun')}</div>
          {calendarCells.map(cellDate => {
            const dayTasks = tasks
              .filter(task => isSameDay(parseISO(task.date), cellDate))
              .slice(0, 2);
            const totalForDay = tasks.filter(task => isSameDay(parseISO(task.date), cellDate)).length;
            return (
              <button
                key={cellDate.toISOString()}
                className={[
                  'calendar-cell',
                  isSameMonth(cellDate, currentDate) ? '' : 'is-faded',
                  isSameDay(cellDate, selectedDate) ? 'is-selected' : '',
                  isSameDay(cellDate, new Date()) ? 'is-today' : '',
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
                    <span className="calendar-more">{t('calendar.more')}</span>
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
              {TASK_COLOR_PALETTE.map(color => (
                <button
                  key={color}
                  style={{ backgroundColor: color }}
                  className={`color-swatch ${selectedColor === color ? 'is-selected' : ''}`}
                  onClick={() => setSelectedColor(color)}
                />
              ))}
            </div>
            <label className="floating-label">
              <span>{t('calendar.taskTitleLabel')}</span>
              <input
                value={draftTitle}
                onChange={event => setDraftTitle(event.target.value)}
                placeholder={t('calendar.taskTitlePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('calendar.notesLabel')}</span>
              <textarea
                rows={3}
                value={draftNotes}
                onChange={event => setDraftNotes(event.target.value)}
                placeholder={t('calendar.taskNotesPlaceholder')}
              />
            </label>
            <label className="floating-label calendar-time-field">
              <span>{t('calendar.timeLabel')}</span>
              <input
                type="time"
                value={draftTime}
                onChange={event => setDraftTime(event.target.value)}
              />
            </label>
            <label className="floating-label calendar-time-field">
              <span>{t('calendar.deadlineLabel')}</span>
              <input
                type="time"
                value={draftDeadlineTime}
                onChange={event => setDraftDeadlineTime(event.target.value)}
              />
            </label>
            {draftDeadlineTime && (
              <label className="floating-label">
                <span>{t('calendar.notifyBeforeLabel')}</span>
                <select
                  value={draftNotifyBefore}
                  onChange={event => setDraftNotifyBefore(Number(event.target.value))}
                >
                  <option value={5}>{t('calendar.notifyBefore5')}</option>
                  <option value={15}>{t('calendar.notifyBefore15')}</option>
                  <option value={30}>{t('calendar.notifyBefore30')}</option>
                  <option value={60}>{t('calendar.notifyBefore60')}</option>
                </select>
              </label>
            )}
            <button className="primary-button add-task" onClick={addTask}>
              <FaPlus /> {t('calendar.addTask')}
            </button>
          </div>

          <div className="sidebar-card task-list-card">
            <h4>{t('calendar.scheduleTitle')}</h4>
            {tasksForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('calendar.noTasksForDay')}</p>
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
                        {task.deadline && (
                          <> · ⏰ {formatDate(language, parseISO(task.deadline), 'h:mm a')}</>
                        )}
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => deleteTask(task.id)}
                      aria-label={t('calendar.deleteTaskAria')}
                    >
                      <FaTrash />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sidebar-card reminder-card">
            <h4>{t('reminders.badge')}</h4>
            <div className="reminder-form">
              <label className="floating-label">
                <span>{t('reminders.label')}</span>
                <input
                  value={reminderTitle}
                  onChange={event => setReminderTitle(event.target.value)}
                  placeholder={t('reminders.placeholder')}
                />
              </label>
              <div className="reminder-time-row">
                <label className="floating-label">
                  <span>{t('calendar.timeLabel')}</span>
                  <input
                    type="time"
                    value={reminderTime}
                    onChange={event => setReminderTime(event.target.value)}
                  />
                </label>
                <button className="primary-button add-reminder-btn" onClick={handleAddReminder}>
                  <FaPlus />
                </button>
              </div>
              <label className="floating-label">
                <span>{t('calendar.notesLabel')}</span>
                <textarea
                  rows={2}
                  value={reminderNotes}
                  onChange={event => setReminderNotes(event.target.value)}
                  placeholder={t('reminders.notesPlaceholder')}
                />
              </label>
            </div>
            {remindersForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('reminders.noForDay')}</p>
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
                        aria-label={t('reminders.toggleAria')}
                      />
                      <button
                        className="icon-button"
                        onClick={() => onDeleteReminder(reminder.id)}
                        aria-label={t('reminders.deleteAria')}
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
