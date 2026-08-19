import React, { useEffect, useMemo, useRef, useState } from 'react';
import { format, subDays } from 'date-fns';
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaArrowLeft, FaEllipsisH, FaArchive, FaTrash } from 'react-icons/fa';
import { db } from '../firebase';
import type { HabitDoc } from './HabitsList';
import type { Subscription } from '../subscription';
import { getActivePlan, FREE_LIMITS } from '../subscription';
import { incrementFreeUsageAtomic, decrementFreeUsageAtomic, subscribeFreeUsage } from '../lib/usageCounters';
import Paywall, { LimitBanner } from './Paywall';
import './Habits.css';

// ── Props ─────────────────────────────────────────────────────────────────────

interface HabitEditorProps {
  habitId: string | null;
  initialHabit?: HabitDoc | null;
  user: User | null;
  language: 'en' | 'ru';
  subscription?: Subscription | null;
  onBack: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const HABIT_COLORS = [
  '#7B68EE', '#4ECDC4', '#FF6B6B', '#45B7D1',
  '#96CEB4', '#FFEAA7', '#DDA0DD', '#FF8A5C',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function calcStreak(completedDates: string[]): number {
  if (!completedDates.length) return 0;
  const doneSet = new Set(completedDates);
  const today = format(new Date(), 'yyyy-MM-dd');
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

function calcBestStreak(completedDates: string[]): number {
  if (!completedDates.length) return 0;
  const sorted = [...completedDates].sort();
  let best = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00');
    const curr = new Date(sorted[i]     + 'T00:00:00');
    const diff = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (diff === 1) {
      current++;
      if (current > best) best = current;
    } else if (diff > 1) {
      current = 1;
    }
  }
  return best;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    back: 'Habits',
    archive: 'Archive',
    unarchive: 'Unarchive',
    delete: 'Delete',
    titlePlaceholder: 'Habit name',
    descPlaceholder: 'Description (optional)',
    repeatLabel: 'REPEAT',
    daily: 'Every day',
    custom: 'Custom days',
    colorLabel: 'COLOR',
    reminderLabel: 'REMINDER',
    statsLabel: 'STATISTICS',
    streakLabel: 'Streak',
    bestLabel: 'Best',
    totalLabel: 'Total',
    heatmapLabel: 'LAST 28 DAYS',
    save: 'Save',
    saving: 'Saving…',
    confirmDelete: 'Delete this habit?',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  ru: {
    back: 'Привычки',
    archive: 'Архивировать',
    unarchive: 'Разархивировать',
    delete: 'Удалить',
    titlePlaceholder: 'Название привычки',
    descPlaceholder: 'Описание (необязательно)',
    repeatLabel: 'ПОВТОРЕНИЕ',
    daily: 'Каждый день',
    custom: 'Выбрать дни',
    colorLabel: 'ЦВЕТ',
    reminderLabel: 'НАПОМИНАНИЕ',
    statsLabel: 'СТАТИСТИКА',
    streakLabel: 'Подряд',
    bestLabel: 'Рекорд',
    totalLabel: 'Всего',
    heatmapLabel: 'ПОСЛЕДНИЕ 28 ДНЕЙ',
    save: 'Сохранить',
    saving: 'Сохранение…',
    confirmDelete: 'Удалить привычку?',
    days: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const HabitEditor: React.FC<HabitEditorProps> = ({
  habitId,
  initialHabit,
  user,
  language,
  subscription,
  onBack,
}) => {
  const t = T[language];
  const isNew = !habitId;

  // ── Form state ──────────────────────────────────────────────────────────────

  const [title,          setTitle]          = useState('');
  const [description,    setDescription]    = useState('');
  const [repeatType,     setRepeatType]     = useState<'daily' | 'custom'>('daily');
  const [repeatDays,     setRepeatDays]     = useState<number[]>([]);
  const [color,          setColor]          = useState(HABIT_COLORS[0]);
  const [reminderTime,   setReminderTime]   = useState('');
  const [completedDates, setCompletedDates] = useState<string[]>([]);
  const [archived,       setArchived]       = useState(false);
  const [saving,         setSaving]         = useState(false);
  const [menuOpen,       setMenuOpen]       = useState(false);
  const [showPaywall,    setShowPaywall]    = useState(false);
  const [usedHabits,     setUsedHabits]     = useState<number | null>(null);

  const plan   = getActivePlan(subscription ?? null);
  const isFree = plan === 'free';
  const limit  = FREE_LIMITS.habits;
  const near80 = usedHabits !== null && usedHabits >= Math.floor(limit * 0.8);

  useEffect(() => {
    if (!user || !isFree) return;
    return subscribeFreeUsage(user.uid, d => setUsedHabits(d.habitCount));
  }, [user, isFree]);

  const menuRef  = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef  = useRef<HTMLTextAreaElement>(null);

  // ── Load initial data ───────────────────────────────────────────────────────

  useEffect(() => {
    if (initialHabit) {
      setTitle(initialHabit.title);
      setDescription(initialHabit.description ?? '');
      setRepeatType(initialHabit.repeatType ?? 'daily');
      setRepeatDays(initialHabit.repeatDays ?? []);
      setColor(initialHabit.color ?? HABIT_COLORS[0]);
      setReminderTime(initialHabit.reminderTime ?? '');
      setCompletedDates(initialHabit.completedDates ?? []);
      setArchived(initialHabit.archived ?? false);
    }
    if (isNew) {
      // Auto-focus title on new habit creation
      const timer = setTimeout(() => titleRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Close menu on outside click ─────────────────────────────────────────────

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // ── Auto-resize description textarea ────────────────────────────────────────

  const autoResize = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  // ── Toggle repeat day ────────────────────────────────────────────────────────

  const toggleDay = (idx: number) => {
    setRepeatDays(prev =>
      prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx]
    );
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!user || !title.trim()) return;

    let atomicDone = false;
    if (isNew && isFree) {
      const result = await incrementFreeUsageAtomic(user.uid, 'habit')
        .catch(() => ({ allowed: true, used: 0, limit }));
      setUsedHabits(result.used);
      if (!result.allowed) { setShowPaywall(true); return; }
      atomicDone = true;
    }

    setSaving(true);
    const id = habitId ?? makeId();
    try {
      const payload: Record<string, unknown> = {
        id,
        userId: user.uid,
        title: title.trim(),
        description: description.trim(),
        color,
        repeatType,
        repeatDays: repeatType === 'custom' ? repeatDays : [],
        reminderTime: reminderTime || null,
        completedDates,
        archived,
        updatedAt: serverTimestamp(),
      };
      if (isNew) payload.createdAt = serverTimestamp();
      await setDoc(doc(db, 'habits', id), payload, { merge: true });
      onBack();
    } catch (err) {
      if (atomicDone) decrementFreeUsageAtomic(user.uid, 'habit').catch(() => {});
      console.warn('HabitEditor save error', err);
      setSaving(false);
    }
  };

  // ── Archive / Unarchive ──────────────────────────────────────────────────────

  const handleArchiveToggle = async () => {
    setMenuOpen(false);
    if (!habitId) { onBack(); return; }
    const next = !archived;
    // Optimistic UI update
    setArchived(next);
    try {
      await updateDoc(doc(db, 'habits', habitId), {
        archived: next,
        updatedAt: serverTimestamp(),
      });
      onBack();
    } catch (err) {
      console.warn('HabitEditor archive error', err);
      setArchived(!next); // revert on error
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!habitId) { onBack(); return; }
    if (!window.confirm(t.confirmDelete)) return;
    try {
      await deleteDoc(doc(db, 'habits', habitId));
    } catch (err) {
      console.warn('HabitEditor delete error', err);
    }
    onBack();
  };

  // ── Heatmap — last 28 days (4 × 7 grid) ─────────────────────────────────────

  const heatmapDays = useMemo(() => {
    const today   = format(new Date(), 'yyyy-MM-dd');
    const doneSet = new Set(completedDates);
    return Array.from({ length: 28 }, (_, i) => {
      const d   = subDays(new Date(), 27 - i);
      const key = format(d, 'yyyy-MM-dd');
      return { key, done: doneSet.has(key), isToday: key === today };
    });
  }, [completedDates]);

  const streak = calcStreak(completedDates);
  const best   = calcBestStreak(completedDates);
  const total  = completedDates.length;

  return (
    <div className="hab-editor">

      {showPaywall && (
        <Paywall
          featureName={language === 'ru' ? `привычки (лимит ${limit})` : `habits (limit ${limit})`}
          language={language}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); onBack(); }}
        />
      )}

      {isNew && isFree && near80 && !showPaywall && (
        <LimitBanner
          message={language === 'ru'
            ? `Привычки: ${usedHabits}/${limit}`
            : `Habits: ${usedHabits}/${limit}`}
          onUpgrade={() => setShowPaywall(true)}
          upgradeLabel={language === 'ru' ? 'Убрать лимит' : 'Remove limit'}
        />
      )}

      {/* ── Toolbar ── */}
      <div className="hab-editor__toolbar">
        <button className="hab-editor__back-btn" onClick={onBack} type="button">
          {/* SVG back arrow — no emoji */}
          <FaArrowLeft /> {t.back}
        </button>

        {/* Three-dot menu — only for existing habits */}
        {!isNew && (
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              className="hab-editor__menu-btn"
              onClick={() => setMenuOpen(v => !v)}
              type="button"
              aria-label="More options"
            >
              {/* SVG horizontal ellipsis — no emoji */}
              <FaEllipsisH />
            </button>

            {menuOpen && (
              <div className="hab-editor__dropdown">
                <button
                  className="hab-editor__dropdown-item"
                  onClick={handleArchiveToggle}
                  type="button"
                >
                  {/* SVG archive icon — no emoji */}
                  <FaArchive />
                  {archived ? t.unarchive : t.archive}
                </button>
                <button
                  className="hab-editor__dropdown-item hab-editor__dropdown-item--danger"
                  onClick={handleDelete}
                  type="button"
                >
                  {/* SVG trash icon — no emoji */}
                  <FaTrash />
                  {t.delete}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Title — large bold borderless input ── */}
      <input
        ref={titleRef}
        className="hab-editor__title-input"
        type="text"
        placeholder={t.titlePlaceholder}
        value={title}
        onChange={e => setTitle(e.target.value)}
      />

      {/* ── Description — auto-resize borderless textarea ── */}
      <textarea
        ref={descRef}
        className="hab-editor__desc-input"
        placeholder={t.descPlaceholder}
        value={description}
        onChange={e => { setDescription(e.target.value); autoResize(); }}
        rows={1}
      />

      {/* ── Repeat ── */}
      <div className="hab-editor__section-label">{t.repeatLabel}</div>
      <div className="hab-editor__repeat-toggle">
        <button
          className={`hab-editor__repeat-btn${repeatType === 'daily' ? ' hab-editor__repeat-btn--active' : ''}`}
          onClick={() => setRepeatType('daily')}
          type="button"
        >
          {t.daily}
        </button>
        <button
          className={`hab-editor__repeat-btn${repeatType === 'custom' ? ' hab-editor__repeat-btn--active' : ''}`}
          onClick={() => setRepeatType('custom')}
          type="button"
        >
          {t.custom}
        </button>
      </div>

      {/* Day selector — only when custom is chosen */}
      {repeatType === 'custom' && (
        <div className="hab-editor__days">
          {t.days.map((label, idx) => (
            <button
              key={idx}
              className={`hab-editor__day-btn${repeatDays.includes(idx) ? ' hab-editor__day-btn--active' : ''}`}
              onClick={() => toggleDay(idx)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Color picker — 8 colored circles, no emoji ── */}
      <div className="hab-editor__section-label">{t.colorLabel}</div>
      <div className="hab-editor__colors-wrap">
        <div className="hab-editor__colors">
          {HABIT_COLORS.map(c => (
            <button
              key={c}
              className={`hab-editor__color-btn${color === c ? ' hab-editor__color-btn--selected' : ''}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
              type="button"
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>

      {/* ── Reminder time ── */}
      <div className="hab-editor__field-wrap">
        <span className="hab-editor__field-label">{t.reminderLabel}</span>
        <input
          className="hab-editor__time-input"
          type="time"
          value={reminderTime}
          onChange={e => setReminderTime(e.target.value)}
        />
      </div>

      {/* ── Statistics + heatmap (existing habits only) ── */}
      {!isNew && (
        <>
          <div className="hab-editor__section-label">{t.statsLabel}</div>
          <div className="hab-editor__stats">
            <div className="hab-editor__stat-card">
              <span className="hab-editor__stat-value">{streak}</span>
              <span className="hab-editor__stat-label">{t.streakLabel}</span>
            </div>
            <div className="hab-editor__stat-card">
              <span className="hab-editor__stat-value">{best}</span>
              <span className="hab-editor__stat-label">{t.bestLabel}</span>
            </div>
            <div className="hab-editor__stat-card">
              <span className="hab-editor__stat-value">{total}</span>
              <span className="hab-editor__stat-label">{t.totalLabel}</span>
            </div>
          </div>

          <div className="hab-editor__section-label">{t.heatmapLabel}</div>
          {/* 4 × 7 grid of colored squares — no emoji */}
          <div className="hab-editor__heatmap">
            {heatmapDays.map(({ key, done, isToday }) => (
              <div
                key={key}
                className={[
                  'hab-editor__heatmap-cell',
                  done    ? 'hab-editor__heatmap-cell--done'  : '',
                  isToday ? 'hab-editor__heatmap-cell--today' : '',
                ].filter(Boolean).join(' ')}
                title={key}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Save button ── */}
      <button
        className="hab-editor__save-btn"
        onClick={handleSave}
        disabled={saving || !title.trim()}
        type="button"
      >
        {saving ? t.saving : t.save}
      </button>
    </div>
  );
};

export default HabitEditor;
