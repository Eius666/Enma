import React, { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaArrowLeft, FaTrash } from 'react-icons/fa';
import { db } from '../firebase';
import type { DayTask } from './DayList';
import { PRIORITY_COLORS } from './DayList';
import type { Subscription } from '../subscription';
import { getActivePlan, FREE_LIMITS } from '../subscription';
import { checkFreeLimit, incrementFreeUsage } from '../lib/freeLimits';
import Paywall, { LimitBanner } from './Paywall';
import './Day.css';

// ── Props ─────────────────────────────────────────────────────────────────────

interface DayTaskEditorProps {
  taskId: string | null;
  initialTask?: DayTask | null;
  initialDate?: string;
  user: User | null;
  language: 'en' | 'ru';
  subscription?: Subscription | null;
  onBack: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayStr(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    back: 'Day',
    delete: 'Delete',
    titlePlaceholder: 'Task title',
    descPlaceholder: 'Description (optional)',
    dateLabel: 'DATE',
    timeLabel: 'TIME',
    priorityLabel: 'PRIORITY',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    save: 'Save',
    saving: 'Saving…',
    confirmDelete: 'Delete this task?',
  },
  ru: {
    back: 'День',
    delete: 'Удалить',
    titlePlaceholder: 'Название задачи',
    descPlaceholder: 'Описание (необязательно)',
    dateLabel: 'ДАТА',
    timeLabel: 'ВРЕМЯ',
    priorityLabel: 'ПРИОРИТЕТ',
    high: 'Высокий',
    medium: 'Средний',
    low: 'Низкий',
    save: 'Сохранить',
    saving: 'Сохранение…',
    confirmDelete: 'Удалить задачу?',
  },
};

// ── Priority option metadata ───────────────────────────────────────────────────

const PRIORITY_ACTIVE_CLASS: Record<DayTask['priority'], string> = {
  high:   'day-editor__priority-chip--high-active',
  medium: 'day-editor__priority-chip--medium-active',
  low:    'day-editor__priority-chip--low-active',
};

// ── Component ─────────────────────────────────────────────────────────────────

const DayTaskEditor: React.FC<DayTaskEditorProps> = ({
  taskId,
  initialTask,
  initialDate,
  user,
  language,
  subscription,
  onBack,
}) => {
  const t     = T[language];
  const isNew = !taskId;

  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [date,        setDate]        = useState(() => initialDate ?? todayStr());
  const [time,        setTime]        = useState('');
  const [priority,    setPriority]    = useState<DayTask['priority']>('medium');
  const [saving,      setSaving]      = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [usedTasks,   setUsedTasks]   = useState<number | null>(null);

  const plan    = getActivePlan(subscription ?? null);
  const isFree  = plan === 'free';
  const limit   = FREE_LIMITS.dailyTasks;
  const near80  = usedTasks !== null && usedTasks >= Math.floor(limit * 0.8);

  useEffect(() => {
    if (!user || !isFree) return;
    checkFreeLimit(user.uid, 'task').then(r => setUsedTasks(r.used)).catch(() => {});
  }, [user, isFree]);

  const titleRef = useRef<HTMLInputElement>(null);
  const descRef  = useRef<HTMLTextAreaElement>(null);

  // ── Populate form from initialTask ──────────────────────────────────────────

  useEffect(() => {
    if (initialTask) {
      setTitle(initialTask.title);
      setDescription(initialTask.description ?? '');
      setDate(initialTask.date ?? todayStr());
      setTime(initialTask.time ?? '');
      setPriority(initialTask.priority ?? 'medium');
    }
    if (isNew) {
      const timer = setTimeout(() => titleRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-resize description ─────────────────────────────────────────────────

  const autoResize = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!user || !title.trim()) return;

    if (isNew && isFree) {
      const result = await checkFreeLimit(user.uid, 'task').catch(() => ({ allowed: true, used: 0, limit }));
      setUsedTasks(result.used);
      if (!result.allowed) {
        setShowPaywall(true);
        return;
      }
    }

    setSaving(true);
    const id = taskId ?? makeId();
    try {
      const payload: Record<string, unknown> = {
        id,
        userId: user.uid,
        title: title.trim(),
        description: description.trim(),
        date,
        time: time || null,
        priority,
        completed: initialTask?.completed ?? false,
        updatedAt: serverTimestamp(),
      };
      if (isNew) payload.createdAt = serverTimestamp();
      await setDoc(doc(db, 'tasks', id), payload, { merge: true });
      if (isNew && isFree) await incrementFreeUsage(user.uid, 'task').catch(() => {});
      onBack();
    } catch (err) {
      console.warn('DayTaskEditor save error', err);
      setSaving(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!taskId) { onBack(); return; }
    if (!window.confirm(t.confirmDelete)) return;
    try {
      await deleteDoc(doc(db, 'tasks', taskId));
    } catch (err) {
      console.warn('DayTaskEditor delete error', err);
    }
    onBack();
  };

  const priorityOptions: { key: DayTask['priority']; label: string }[] = [
    { key: 'high',   label: t.high   },
    { key: 'medium', label: t.medium },
    { key: 'low',    label: t.low    },
  ];

  return (
    <div className="day-editor">

      {showPaywall && (
        <Paywall
          featureName={language === 'ru' ? `задачи (лимит ${limit}/день)` : `tasks (limit ${limit}/day)`}
          language={language}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); onBack(); }}
        />
      )}

      {isNew && isFree && near80 && !showPaywall && (
        <LimitBanner
          message={language === 'ru'
            ? `Задачи: ${usedTasks}/${limit} за сегодня`
            : `Tasks: ${usedTasks}/${limit} today`}
          onUpgrade={() => setShowPaywall(true)}
          upgradeLabel={language === 'ru' ? 'Убрать лимит' : 'Remove limit'}
        />
      )}

      {/* ── Toolbar ── */}
      <div className="day-editor__toolbar">
        <button className="day-editor__back-btn" onClick={onBack} type="button">
          {/* SVG arrow — no emoji */}
          <FaArrowLeft /> {t.back}
        </button>
        {!isNew && (
          <button className="day-editor__del-btn" onClick={handleDelete} type="button">
            {/* SVG trash — no emoji */}
            <FaTrash /> {t.delete}
          </button>
        )}
      </div>

      {/* ── Title — borderless, 22px bold, auto-focus on new ── */}
      <input
        ref={titleRef}
        className="day-editor__title-input"
        type="text"
        placeholder={t.titlePlaceholder}
        value={title}
        onChange={e => setTitle(e.target.value)}
      />

      {/* ── Description — auto-resize, borderless ── */}
      <textarea
        ref={descRef}
        className="day-editor__desc-input"
        placeholder={t.descPlaceholder}
        value={description}
        onChange={e => { setDescription(e.target.value); autoResize(); }}
        rows={1}
      />

      {/* ── Date ── */}
      <div className="day-editor__field-wrap">
        <span className="day-editor__field-label">{t.dateLabel}</span>
        <input
          className="day-editor__date-input"
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
        />
      </div>

      {/* ── Time (optional) ── */}
      <div className="day-editor__field-wrap">
        <span className="day-editor__field-label">{t.timeLabel}</span>
        <input
          className="day-editor__time-input"
          type="time"
          value={time}
          onChange={e => setTime(e.target.value)}
        />
      </div>

      {/* ── Priority chips — colored dots, no emoji ── */}
      <div className="day-editor__section-label">{t.priorityLabel}</div>
      <div className="day-editor__priority-row">
        {priorityOptions.map(({ key, label }) => {
          const isActive = priority === key;
          return (
            <button
              key={key}
              className={`day-editor__priority-chip${isActive ? ` ${PRIORITY_ACTIVE_CLASS[key]}` : ''}`}
              onClick={() => setPriority(key)}
              type="button"
            >
              {/* Colored dot — no emoji */}
              <span
                className="day-editor__priority-dot"
                style={{ backgroundColor: PRIORITY_COLORS[key] }}
              />
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Save ── */}
      <button
        className="day-editor__save-btn"
        onClick={handleSave}
        disabled={saving || !title.trim()}
        type="button"
      >
        {saving ? t.saving : t.save}
      </button>
    </div>
  );
};

export default DayTaskEditor;
