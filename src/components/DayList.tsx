import React, { useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import {
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaSearch, FaCheck, FaCalendarDay } from 'react-icons/fa';
import { db } from '../firebase';
import './Day.css';

// ── Shared types & constants ──────────────────────────────────────────────────

export interface DayTask {
  id: string;
  userId: string;
  title: string;
  description?: string;
  date: string;       // 'YYYY-MM-DD'
  time?: string | null; // 'HH:MM', null = no time
  priority: 'high' | 'medium' | 'low';
  completed: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** Priority indicator colours — CSS hex, used in list and editor (no emoji) */
export const PRIORITY_COLORS: Record<DayTask['priority'], string> = {
  high:   '#ff4757',
  medium: '#ffc107',
  low:    '#2ecc71',
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface HabitSummary {
  completedDates?: string[];
  archived?: boolean;
}

interface TxSummary {
  type: 'income' | 'expense';
  amount: number;
  date: string;
}

interface DayListProps {
  language: 'en' | 'ru';
  user: User | null;
  currency: string;
  convertAmount: (n: number) => number;
  firestoreHabits: HabitSummary[];
  transactions: TxSummary[];
  tasks: DayTask[];                            // All user tasks; filtered by today inside
  onOpenEditor: (taskId: string | null) => void;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    taskCount: (n: number) => n === 1 ? '1 task today' : `${n} tasks today`,
    noTasks: 'Free day — enjoy it',
    tasksLabel: 'Tasks',
    habitsLabel: 'Habits',
    financeLabel: 'Expenses',
    search: 'Search tasks…',
    sectionActive: 'Today',
    sectionDone: 'Completed',
    emptyTitle: 'No tasks today',
    emptyHint: 'Tap + to add a task',
    newTask: 'New task',
    confirmDelete: 'Delete this task?',
    editLabel: 'Edit',
    delLabel: 'Del',
  },
  ru: {
    taskCount: (n: number) => {
      const m100 = n % 100;
      const m10  = n % 10;
      if (m100 >= 11 && m100 <= 14) return `${n} задач сегодня`;
      if (m10 === 1) return `${n} задача сегодня`;
      if (m10 >= 2 && m10 <= 4) return `${n} задачи сегодня`;
      return `${n} задач сегодня`;
    },
    noTasks: 'Свободный день — наслаждайся',
    tasksLabel: 'Задачи',
    habitsLabel: 'Привычки',
    financeLabel: 'Расходы',
    search: 'Поиск задач…',
    sectionActive: 'Сегодня',
    sectionDone: 'Выполненные',
    emptyTitle: 'Задач на сегодня нет',
    emptyHint: 'Нажмите + чтобы добавить',
    newTask: 'Новая задача',
    confirmDelete: 'Удалить задачу?',
    editLabel: 'Изм.',
    delLabel: 'Удал.',
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const DayList: React.FC<DayListProps> = ({
  language,
  user,
  currency,
  convertAmount,
  firestoreHabits,
  transactions,
  tasks,
  onOpenEditor,
}) => {
  const t      = T[language];
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  const today  = format(new Date(), 'yyyy-MM-dd');

  const [searchQuery, setSearchQuery] = useState('');
  const [swipedId, setSwipedId]       = useState<string | null>(null);
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);

  // ── Derive today's tasks (received from App.tsx for all dates) ──────────────

  const todayTasks = useMemo(
    () => tasks.filter(tk => tk.date === today),
    [tasks, today]
  );

  // ── Summary ─────────────────────────────────────────────────────────────────

  const completedCount = todayTasks.filter(tk => tk.completed).length;
  const totalCount     = todayTasks.length;

  const habitsToday = useMemo(() => {
    const active = firestoreHabits.filter(h => !h.archived);
    const done   = active.filter(h => (h.completedDates ?? []).includes(today));
    return { done: done.length, total: active.length };
  }, [firestoreHabits, today]);

  const todayExpenses = useMemo(() => {
    return transactions
      .filter(tx => {
        if (tx.type !== 'expense') return false;
        try {
          return format(new Date(tx.date), 'yyyy-MM-dd') === today;
        } catch {
          return false;
        }
      })
      .reduce((sum, tx) => sum + tx.amount, 0);
  }, [transactions, today]);

  const fmt = (n: number) =>
    convertAmount(n).toLocaleString(locale, { style: 'currency', currency: currency as 'USD' });

  // ── Date header label ────────────────────────────────────────────────────────

  const dateLabel = format(new Date(), 'EEEE, d MMMM', {
    locale: language === 'ru' ? ruLocale : enUS,
  });
  const capitalizedDate = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);

  // ── Filtered tasks ────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return todayTasks;
    return todayTasks.filter(tk => tk.title.toLowerCase().includes(q));
  }, [todayTasks, searchQuery]);

  const activeTasks    = filtered.filter(tk => !tk.completed);
  const completedTasks = filtered.filter(tk =>  tk.completed);

  // ── Checkbox toggle ───────────────────────────────────────────────────────────

  const handleToggle = async (task: DayTask, e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    try {
      await updateDoc(doc(db, 'tasks', task.id), {
        completed: !task.completed,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('DayList toggle error', err);
    }
  };

  // ── Swipe ─────────────────────────────────────────────────────────────────────

  const onTouchStart = (id: string, e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    if (swipedId && swipedId !== id) setSwipedId(null);
  };

  const onTouchEnd = (id: string, e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    if (dy > 20) return;
    if (dx < -50) setSwipedId(id);
    else if (dx > 20 && swipedId === id) setSwipedId(null);
  };

  // ── Delete ────────────────────────────────────────────────────────────────────

  const handleDelete = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    if (!window.confirm(t.confirmDelete)) { setSwipedId(null); return; }
    try {
      await deleteDoc(doc(db, 'tasks', taskId));
      setSwipedId(null);
    } catch (err) {
      console.warn('DayList delete error', err);
    }
  };

  // ── Row renderer ──────────────────────────────────────────────────────────────

  const renderTask = (task: DayTask) => {
    const isRevealed = swipedId === task.id;
    const prioColor  = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium;

    return (
      <div
        key={task.id}
        className="day-list__item-wrap"
        onTouchStart={e => onTouchStart(task.id, e)}
        onTouchEnd={e => onTouchEnd(task.id, e)}
      >
        {/* Action buttons revealed by swipe-left — text labels, no emoji */}
        <div className="day-list__item-actions">
          <button
            className="day-list__item-action-btn day-list__item-action-btn--edit"
            onClick={e => { e.stopPropagation(); setSwipedId(null); onOpenEditor(task.id); }}
            type="button"
          >
            {t.editLabel}
          </button>
          <button
            className="day-list__item-action-btn day-list__item-action-btn--delete"
            onClick={e => handleDelete(task.id, e)}
            type="button"
          >
            {t.delLabel}
          </button>
        </div>

        {/* Task card — slides left to reveal actions */}
        <button
          className={`day-list__item${task.completed ? ' day-list__item--completed' : ''}`}
          style={{ transform: isRevealed ? 'translateX(-144px)' : 'translateX(0)' }}
          onClick={() => {
            if (isRevealed) { setSwipedId(null); return; }
            onOpenEditor(task.id);
          }}
          type="button"
        >
          {/* Priority strip — colored, 4px wide, no emoji */}
          <span
            className="day-list__item-priority"
            style={{ backgroundColor: prioColor }}
          />

          {/* Round checkbox — SVG check icon, no emoji */}
          <span
            className={`day-list__item-check${task.completed ? ' day-list__item-check--done' : ''}`}
            onClick={e => handleToggle(task, e)}
            onTouchEnd={e => handleToggle(task, e)}
            role="checkbox"
            aria-checked={task.completed}
          >
            {task.completed && <FaCheck className="day-list__item-check-icon" />}
          </span>

          <span className="day-list__item-body">
            <span className="day-list__item-title">{task.title}</span>
            {task.description && (
              <span className="day-list__item-desc">{task.description}</span>
            )}
          </span>

          {task.time && (
            <span className="day-list__item-time">{task.time}</span>
          )}
        </button>
      </div>
    );
  };

  const isEmpty = activeTasks.length === 0 && completedTasks.length === 0;

  return (
    <>
    <div className="day-list" onClick={() => swipedId && setSwipedId(null)}>

      {/* ── Date header ── */}
      <div className="day-list__header">
        <span className="day-list__date">{capitalizedDate}</span>
        <span className="day-list__subtitle">
          {totalCount > 0 ? t.taskCount(totalCount) : t.noTasks}
        </span>
      </div>

      {/* ── Mini-summary: Tasks / Habits / Expenses ── */}
      <div className="day-list__summary">
        <div className="day-list__summary-card">
          <span className="day-list__summary-label">{t.tasksLabel}</span>
          <span className="day-list__summary-value">
            {completedCount}/{totalCount}
          </span>
        </div>
        <div className="day-list__summary-card">
          <span className="day-list__summary-label">{t.habitsLabel}</span>
          <span className="day-list__summary-value">
            {habitsToday.done}/{habitsToday.total}
          </span>
        </div>
        <div className="day-list__summary-card">
          <span className="day-list__summary-label">{t.financeLabel}</span>
          <span className="day-list__summary-value day-list__summary-value--expense">
            {todayExpenses > 0 ? `−${fmt(todayExpenses)}` : '—'}
          </span>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="day-list__search-wrap">
        {/* SVG search icon — no emoji */}
        <FaSearch className="day-list__search-icon" />
        <input
          className="day-list__search"
          type="text"
          placeholder={t.search}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* ── Task list ── */}
      {isEmpty ? (
        <div className="day-list__empty">
          {/* SVG calendar icon — no emoji */}
          <span className="day-list__empty-icon">
            <FaCalendarDay />
          </span>
          <span className="day-list__empty-title">{t.emptyTitle}</span>
          <span className="day-list__empty-hint">{t.emptyHint}</span>
        </div>
      ) : (
        <>
          {activeTasks.length > 0 && (
            <>
              <div className="day-list__section-label">{t.sectionActive}</div>
              {activeTasks.map(renderTask)}
            </>
          )}
          {completedTasks.length > 0 && (
            <>
              <div className="day-list__section-label">{t.sectionDone}</div>
              {completedTasks.map(renderTask)}
            </>
          )}
        </>
      )}

    </div>

    {/* FAB — outside animated container so position:fixed isn't affected by transform */}
    <button
      className="fab"
      onClick={() => onOpenEditor(null)}
      type="button"
      aria-label={t.newTask}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    </>
  );
};

export default DayList;
