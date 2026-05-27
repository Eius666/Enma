import React, { useMemo, useState } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  addMonths,
  subMonths,
  subDays,
  addDays,
  getDay,
} from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import { FaChevronLeft, FaChevronRight, FaCheck, FaCalendarDay } from 'react-icons/fa';
import {
  doc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { db } from '../firebase';
import type { DayTask } from './DayList';
import { PRIORITY_COLORS } from './DayList';
import './Calendar.css';

// ── Props ─────────────────────────────────────────────────────────────────────

interface CalendarViewProps {
  language: 'en' | 'ru';
  user: User | null;
  tasks: DayTask[];
  onOpenEditor: (taskId: string | null, date?: string) => void;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    todayBtn: 'Today',
    weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
    emptyTitle: 'No tasks for this day',
    emptyHint: 'Tap + to add a task',
    newTask:   'New task',
  },
  ru: {
    todayBtn:  'Сегодня',
    weekdays:  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    emptyTitle: 'Задач на этот день нет',
    emptyHint: 'Нажмите + чтобы добавить',
    newTask:   'Новая задача',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Convert getDay() (0 = Sun) to Monday-first index (0 = Mon … 6 = Sun). */
function monFirst(day: number): number {
  return (day + 6) % 7;
}

// ── Component ─────────────────────────────────────────────────────────────────

const CalendarView: React.FC<CalendarViewProps> = ({
  language,
  user,
  tasks,
  onOpenEditor,
}) => {
  const t      = T[language];
  const locale = language === 'ru' ? ruLocale : enUS;
  const today  = todayStr();

  const [currentMonth, setCurrentMonth] = useState<Date>(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string>(today);

  // ── Calendar cells ────────────────────────────────────────────────────────────

  const cells = useMemo(() => {
    const first     = startOfMonth(currentMonth);
    const last      = endOfMonth(currentMonth);
    const startCell = subDays(first, monFirst(getDay(first)));
    const endCell   = addDays(last,  6 - monFirst(getDay(last)));
    return eachDayOfInterval({ start: startCell, end: endCell });
  }, [currentMonth]);

  // ── Tasks grouped by date string ──────────────────────────────────────────────

  const tasksByDate = useMemo(() => {
    const map = new Map<string, DayTask[]>();
    tasks.forEach(task => {
      const arr = map.get(task.date) ?? [];
      arr.push(task);
      map.set(task.date, arr);
    });
    return map;
  }, [tasks]);

  // ── Tasks for selected day (time-sorted) ─────────────────────────────────────

  const selectedTasks = useMemo(() => {
    return (tasksByDate.get(selectedDate) ?? []).slice().sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return 0;
    });
  }, [tasksByDate, selectedDate]);

  // ── Toggle completion ─────────────────────────────────────────────────────────

  const handleToggle = async (task: DayTask, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    try {
      await updateDoc(doc(db, 'tasks', task.id), {
        completed: !task.completed,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('CalendarView toggle error', err);
    }
  };

  // ── Labels ────────────────────────────────────────────────────────────────────

  const monthRaw   = format(currentMonth, 'LLLL yyyy', { locale });
  const monthLabel = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1);

  const selectedLabel = (() => {
    try {
      const d   = new Date(selectedDate + 'T00:00:00');
      const raw = format(d, 'd MMMM', { locale });
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    } catch {
      return selectedDate;
    }
  })();

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="cal-view">

      {/* ── Month navigation ── */}
      <div className="cal-view__month-nav">
        <button
          className="cal-view__nav-btn"
          onClick={() => setCurrentMonth(prev => subMonths(prev, 1))}
          type="button"
          aria-label="Previous month"
        >
          {/* SVG chevron — no emoji */}
          <FaChevronLeft />
        </button>

        <span className="cal-view__month-label">{monthLabel}</span>

        <button
          className="cal-view__nav-btn"
          onClick={() => setCurrentMonth(prev => addMonths(prev, 1))}
          type="button"
          aria-label="Next month"
        >
          {/* SVG chevron — no emoji */}
          <FaChevronRight />
        </button>

        <button
          className="cal-view__today-btn"
          onClick={() => { setCurrentMonth(new Date()); setSelectedDate(today); }}
          type="button"
        >
          {t.todayBtn}
        </button>
      </div>

      {/* ── Weekday headers — text labels, no emoji ── */}
      <div className="cal-view__weekdays">
        {t.weekdays.map(wd => (
          <span key={wd} className="cal-view__weekday">{wd}</span>
        ))}
      </div>

      {/* ── Calendar grid ── */}
      <div className="cal-view__grid">
        {cells.map(cell => {
          const cellStr    = format(cell, 'yyyy-MM-dd');
          const inMonth    = cell.getMonth()     === currentMonth.getMonth()
                          && cell.getFullYear()  === currentMonth.getFullYear();
          const isCurrentDay = cellStr === today;
          const isSelected   = cellStr === selectedDate;
          const cellTasks    = tasksByDate.get(cellStr) ?? [];
          /* Up to 3 colored priority dots */
          const dotColors    = cellTasks
            .slice(0, 3)
            .map(tk => PRIORITY_COLORS[tk.priority] ?? PRIORITY_COLORS.medium);

          return (
            <button
              key={cellStr}
              className={[
                'cal-view__cell',
                !inMonth                     ? 'cal-view__cell--other-month' : '',
                isCurrentDay                 ? 'cal-view__cell--today'       : '',
                isSelected && !isCurrentDay  ? 'cal-view__cell--selected'    : '',
              ].filter(Boolean).join(' ')}
              onClick={() => {
                setSelectedDate(cellStr);
                if (!inMonth) setCurrentMonth(cell);
              }}
              type="button"
            >
              <span className="cal-view__cell-num">{cell.getDate()}</span>
              {/* Priority dots — no emoji */}
              {dotColors.length > 0 && (
                <span className="cal-view__cell-dots">
                  {dotColors.map((color, i) => (
                    <span
                      key={i}
                      className="cal-view__cell-dot"
                      style={{ backgroundColor: isCurrentDay ? '#fff' : color }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Selected day heading ── */}
      <div className="cal-view__day-label">{selectedLabel}</div>

      {/* ── Task list or empty state ── */}
      {selectedTasks.length === 0 ? (
        <div className="cal-view__empty">
          {/* SVG calendar icon — no emoji */}
          <span className="cal-view__empty-icon"><FaCalendarDay /></span>
          <span className="cal-view__empty-title">{t.emptyTitle}</span>
          <span className="cal-view__empty-hint">{t.emptyHint}</span>
        </div>
      ) : (
        <div className="cal-view__task-list">
          {selectedTasks.map(task => {
            const prioColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium;
            return (
              <button
                key={task.id}
                className={`cal-view__task${task.completed ? ' cal-view__task--completed' : ''}`}
                onClick={() => onOpenEditor(task.id)}
                type="button"
              >
                {/* Priority strip — 4px colored, no emoji */}
                <span
                  className="cal-view__task-priority"
                  style={{ backgroundColor: prioColor }}
                />
                {/* Round checkbox — SVG check, no emoji */}
                <span
                  className={`cal-view__task-check${task.completed ? ' cal-view__task-check--done' : ''}`}
                  onClick={e => handleToggle(task, e)}
                  role="checkbox"
                  aria-checked={task.completed}
                >
                  {task.completed && <FaCheck className="cal-view__task-check-icon" />}
                </span>
                <span className="cal-view__task-body">
                  <span className="cal-view__task-title">{task.title}</span>
                  {task.description && (
                    <span className="cal-view__task-desc">{task.description}</span>
                  )}
                </span>
                {task.time && (
                  <span className="cal-view__task-time">{task.time}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── FAB — SVG plus icon, creates task for selected date ── */}
      <button
        className="fab"
        onClick={() => onOpenEditor(null, selectedDate)}
        type="button"
        aria-label={t.newTask}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
};

export default CalendarView;
