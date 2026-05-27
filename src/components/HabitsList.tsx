import React, { useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { FaSearch, FaCheck, FaCheckCircle, FaTimes } from 'react-icons/fa';
import {
  doc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { db } from '../firebase';
import './Habits.css';

// ── Shared type ───────────────────────────────────────────────────────────────

export interface HabitDoc {
  id: string;
  userId: string;
  title: string;
  description?: string;
  color: string;
  completedDates: string[]; // 'YYYY-MM-DD'
  repeatType: 'daily' | 'custom';
  repeatDays?: number[];    // 0=Mon … 6=Sun
  reminderTime?: string;
  archived: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface HabitsListProps {
  language: 'en' | 'ru';
  user: User | null;
  habits: HabitDoc[];
  onOpenEditor: (habitId: string | null) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayKey(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Count consecutive days ending today (or yesterday if today not done). */
function calcStreak(completedDates: string[]): number {
  if (!completedDates.length) return 0;
  const doneSet = new Set(completedDates);
  const today = todayKey();
  // If today is not done, check if yesterday is the start of the streak
  let cursor = today;
  if (!doneSet.has(cursor)) {
    const yest = new Date(cursor + 'T00:00:00');
    yest.setDate(yest.getDate() - 1);
    cursor = format(yest, 'yyyy-MM-dd');
  }
  let n = 0;
  while (doneSet.has(cursor)) {
    n++;
    const d = new Date(cursor + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    cursor = format(d, 'yyyy-MM-dd');
  }
  return n;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    donePrefix: 'Done today:',
    doneSep: ' of ',
    search: 'Search habits…',
    sectionActive: 'Today',
    sectionArchived: 'Archived',
    streakLabel: (n: number) => (n === 1 ? '1 day in a row' : `${n} days in a row`),
    streakZero: 'Start today',
    emptyTitle: 'No habits yet',
    emptyHint: 'Tap + to create a habit',
    newHabit: 'New habit',
    confirmDelete: 'Delete this habit?',
  },
  ru: {
    donePrefix: 'Выполнено сегодня:',
    doneSep: ' из ',
    search: 'Поиск привычек…',
    sectionActive: 'Сегодня',
    sectionArchived: 'Архивированные',
    streakLabel: (n: number) => {
      const m100 = n % 100;
      const m10  = n % 10;
      if (m100 >= 11 && m100 <= 14) return `${n} дней подряд`;
      if (m10 === 1) return `${n} день подряд`;
      if (m10 >= 2 && m10 <= 4) return `${n} дня подряд`;
      return `${n} дней подряд`;
    },
    streakZero: 'Начни сегодня',
    emptyTitle: 'Привычек пока нет',
    emptyHint: 'Нажмите + чтобы создать',
    newHabit: 'Новая привычка',
    confirmDelete: 'Удалить привычку?',
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const HabitsList: React.FC<HabitsListProps> = ({
  language,
  user,
  habits,
  onOpenEditor,
}) => {
  const t = T[language];
  const today = todayKey();

  const [searchQuery, setSearchQuery] = useState('');
  // ID of the habit whose delete button is currently revealed (swipe-left)
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);

  // ── Derived data ────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return habits;
    return habits.filter(h => h.title.toLowerCase().includes(q));
  }, [habits, searchQuery]);

  const filteredActive   = filtered.filter(h => !h.archived);
  const filteredArchived = filtered.filter(h =>  h.archived);

  const activeHabits = useMemo(() => habits.filter(h => !h.archived), [habits]);

  const doneTodayCount = useMemo(
    () => activeHabits.filter(h => (h.completedDates ?? []).includes(today)).length,
    [activeHabits, today]
  );
  const totalActive = activeHabits.length;
  const progressPct = totalActive > 0 ? Math.round((doneTodayCount / totalActive) * 100) : 0;

  // ── Checkbox toggle — writes directly to Firestore ──────────────────────────

  const handleToggle = async (habit: HabitDoc, e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    if (!user) return;
    const dates = habit.completedDates ?? [];
    const isDone = dates.includes(today);
    const ref = doc(db, 'habits', habit.id);
    try {
      if (isDone) {
        await updateDoc(ref, {
          completedDates: arrayRemove(today),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(ref, {
          completedDates: arrayUnion(today),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      console.warn('HabitsList toggle error', err);
    }
  };

  // ── Swipe-to-delete ─────────────────────────────────────────────────────────

  const onTouchStart = (id: string, e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    // Tap on a different item closes the currently revealed one
    if (swipedId && swipedId !== id) setSwipedId(null);
  };

  const onTouchEnd = (id: string, e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    if (dy > 20) return; // vertical scroll, ignore
    if (dx < -50) {
      setSwipedId(id);
    } else if (dx > 20 && swipedId === id) {
      setSwipedId(null);
    }
  };

  const handleDeleteFromSwipe = async (habitId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t.confirmDelete)) {
      setSwipedId(null);
      return;
    }
    try {
      await deleteDoc(doc(db, 'habits', habitId));
      setSwipedId(null);
    } catch (err) {
      console.warn('HabitsList delete error', err);
    }
  };

  // ── Row renderer ─────────────────────────────────────────────────────────────

  const renderHabit = (habit: HabitDoc) => {
    const dates  = habit.completedDates ?? [];
    const isDone = dates.includes(today);
    const streak = calcStreak(dates);
    const isRevealed = swipedId === habit.id;

    return (
      <div
        key={habit.id}
        className="hab-list__item-wrap"
        onTouchStart={e => onTouchStart(habit.id, e)}
        onTouchEnd={e => onTouchEnd(habit.id, e)}
      >
        {/* Delete button — revealed by swipe left; no emoji */}
        <button
          className="hab-list__item-delete"
          onClick={e => handleDeleteFromSwipe(habit.id, e)}
          type="button"
          aria-label="Delete habit"
        >
          {/* SVG × icon — no emoji */}
          <FaTimes />
        </button>

        {/* Main row — translates left to reveal the delete button */}
        <button
          className="hab-list__item"
          style={{ transform: isRevealed ? 'translateX(-80px)' : 'translateX(0)' }}
          onClick={() => {
            if (isRevealed) { setSwipedId(null); return; }
            onOpenEditor(habit.id);
          }}
          type="button"
        >
          {/* Colored dot — background set inline, no emoji */}
          <span
            className="hab-list__item-dot"
            style={{ backgroundColor: habit.color }}
          />

          <span className="hab-list__item-body">
            <span className="hab-list__item-title">{habit.title}</span>
            <span className="hab-list__item-streak">
              {streak > 0 ? t.streakLabel(streak) : t.streakZero}
            </span>
          </span>

          {/* Round checkbox — SVG check icon, no emoji */}
          <span
            className={`hab-list__item-check${isDone ? ' hab-list__item-check--done' : ''}`}
            onClick={e => handleToggle(habit, e)}
            onTouchEnd={e => handleToggle(habit, e)}
            role="checkbox"
            aria-checked={isDone}
          >
            {isDone && <FaCheck className="hab-list__item-check-icon" />}
          </span>
        </button>
      </div>
    );
  };

  const isEmpty = filteredActive.length === 0 && filteredArchived.length === 0;

  return (
    <>
    <div className="hab-list" onClick={() => swipedId && setSwipedId(null)}>

      {/* ── Progress summary ── */}
      <div className="hab-list__summary">
        <div className="hab-list__summary-text">
          {t.donePrefix}{' '}
          <strong>{doneTodayCount}</strong>
          {t.doneSep}
          <strong>{totalActive}</strong>
        </div>
        <div className="hab-list__progress-wrap">
          <div
            className="hab-list__progress-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* ── Search bar ── */}
      <div className="hab-list__search-wrap">
        <FaSearch className="hab-list__search-icon" />
        <input
          className="hab-list__search"
          type="text"
          placeholder={t.search}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* ── Habit list ── */}
      {isEmpty ? (
        <div className="hab-list__empty">
          {/* SVG icon — no emoji */}
          <span className="hab-list__empty-icon">
            <FaCheckCircle />
          </span>
          <span className="hab-list__empty-title">{t.emptyTitle}</span>
          <span className="hab-list__empty-hint">{t.emptyHint}</span>
        </div>
      ) : (
        <>
          {filteredActive.length > 0 && (
            <>
              <div className="hab-list__section-label">{t.sectionActive}</div>
              {filteredActive.map(renderHabit)}
            </>
          )}
          {filteredArchived.length > 0 && (
            <>
              <div className="hab-list__section-label">{t.sectionArchived}</div>
              {filteredArchived.map(renderHabit)}
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
      aria-label={t.newHabit}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    </>
  );
};

export default HabitsList;
