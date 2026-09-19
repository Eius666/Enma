import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaPlus, FaTrash } from 'react-icons/fa';
import { db } from '../firebase';
import { formatCurrency } from '../utils/formatCurrency';
import './Finance.css';

interface Goal {
  id: string;
  title: string;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  deadline?: string | null;
  createdAt?: { toMillis?: () => number } | null;
}

interface GoalsListProps {
  user: User | null;
  language: 'en' | 'ru';
}

const T = {
  en: {
    empty: 'No savings goals yet',
    emptyHint: 'Create a goal and put money aside step by step.',
    newGoal: 'New goal',
    title: 'Goal name',
    target: 'Target amount',
    deadline: 'Deadline (optional)',
    create: 'Create',
    cancel: 'Cancel',
    deposit: 'Add',
    withdraw: 'Withdraw',
    amount: 'Amount',
    confirm: 'Confirm',
    del: 'Delete',
    confirmDelete: 'Delete this goal?',
    left: 'left',
    reached: 'Goal reached!',
    until: 'by',
    invalid: 'Check the values',
    insufficient: 'Not enough saved in this goal',
    failed: 'Could not save. Try again.',
  },
  ru: {
    empty: 'Целей пока нет',
    emptyHint: 'Создайте цель и откладывайте деньги шаг за шагом.',
    newGoal: 'Новая цель',
    title: 'Название цели',
    target: 'Нужная сумма',
    deadline: 'Срок (необязательно)',
    create: 'Создать',
    cancel: 'Отмена',
    deposit: 'Пополнить',
    withdraw: 'Снять',
    amount: 'Сумма',
    confirm: 'Готово',
    del: 'Удалить',
    confirmDelete: 'Удалить эту цель?',
    left: 'осталось',
    reached: 'Цель достигнута!',
    until: 'до',
    invalid: 'Проверьте значения',
    insufficient: 'В цели накоплено меньше',
    failed: 'Не удалось сохранить. Попробуйте ещё раз.',
  },
};

const GoalsList: React.FC<GoalsListProps> = ({ user, language }) => {
  const t = T[language];
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [adjust, setAdjust] = useState<{ id: string; direction: 'deposit' | 'withdraw' } | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Goals are read straight from Firestore (owner-only read rule); every write
  // goes through the API, which owns the numbers.
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'goals'), where('userId', '==', user.uid));
    return onSnapshot(
      q,
      snap => setGoals(snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<Goal, 'id'>) }))),
      err => console.warn('Goals listener error', err),
    );
  }, [user]);

  const sorted = useMemo(
    () => [...goals].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)),
    [goals],
  );

  const call = async (action: string, body: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> => {
    if (!user) return { ok: false };
    setBusy(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const resp = await fetch(`/api/ai/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(data?.code === 'INSUFFICIENT' ? t.insufficient : data?.code === 'VALIDATION_ERROR' ? t.invalid : t.failed);
        return { ok: false, code: data?.code };
      }
      return { ok: true };
    } catch {
      setError(t.failed);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    const targetAmount = parseFloat(target);
    if (!title.trim() || !(targetAmount > 0)) { setError(t.invalid); return; }
    const res = await call('goalCreate', { title: title.trim(), targetAmount, deadline: deadline || null });
    if (res.ok) { setTitle(''); setTarget(''); setDeadline(''); setShowForm(false); }
  };

  const handleAdjust = async () => {
    if (!adjust) return;
    const amount = parseFloat(adjustAmount);
    if (!(amount > 0)) { setError(t.invalid); return; }
    const res = await call('goalAdjust', { id: adjust.id, amount, direction: adjust.direction });
    if (res.ok) { setAdjust(null); setAdjustAmount(''); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t.confirmDelete)) return;
    await call('goalDelete', { id });
  };

  const fmtDeadline = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="goals">
      {error && <div className="fin-editor__error" role="alert">{error}</div>}

      {showForm ? (
        <div className="goals__form">
          <input className="goals__input" placeholder={t.title} value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
          <input className="goals__input" placeholder={t.target} type="number" inputMode="decimal" min="0" step="0.01" value={target} onChange={e => setTarget(e.target.value)} />
          <label className="goals__label">{t.deadline}
            <input className="goals__input" type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
          </label>
          <div className="goals__row">
            <button className="goals__btn goals__btn--primary" disabled={busy} onClick={handleCreate} type="button">{t.create}</button>
            <button className="goals__btn" onClick={() => { setShowForm(false); setError(null); }} type="button">{t.cancel}</button>
          </div>
        </div>
      ) : (
        <button className="goals__add" onClick={() => setShowForm(true)} type="button"><FaPlus /> {t.newGoal}</button>
      )}

      {sorted.length === 0 && !showForm && (
        <div className="goals__empty">
          <div>{t.empty}</div>
          <div className="goals__empty-hint">{t.emptyHint}</div>
        </div>
      )}

      {sorted.map(g => {
        const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100)) : 0;
        const done = g.currentAmount >= g.targetAmount && g.targetAmount > 0;
        const cur = g.currency || 'RUB';
        const isAdjusting = adjust?.id === g.id;
        return (
          <div className="goals__card" key={g.id}>
            <div className="goals__head">
              <span className="goals__title">{g.title}</span>
              <button className="goals__icon-btn" onClick={() => handleDelete(g.id)} aria-label={t.del} type="button"><FaTrash /></button>
            </div>
            <div className="goals__amounts">
              {formatCurrency(g.currentAmount, cur, language)} / {formatCurrency(g.targetAmount, cur, language)}
            </div>
            <div className="goals__bar"><div className={`goals__bar-fill${done ? ' goals__bar-fill--done' : ''}`} style={{ width: `${pct}%` }} /></div>
            <div className="goals__meta">
              <span>{done ? t.reached : `${pct}% · ${t.left} ${formatCurrency(Math.max(0, g.targetAmount - g.currentAmount), cur, language)}`}</span>
              {g.deadline && <span>{t.until} {fmtDeadline(g.deadline)}</span>}
            </div>
            {isAdjusting ? (
              <div className="goals__row">
                <input className="goals__input" placeholder={t.amount} type="number" inputMode="decimal" min="0" step="0.01" value={adjustAmount} onChange={e => setAdjustAmount(e.target.value)} autoFocus />
                <button className="goals__btn goals__btn--primary" disabled={busy} onClick={handleAdjust} type="button">{t.confirm}</button>
                <button className="goals__btn" onClick={() => { setAdjust(null); setAdjustAmount(''); setError(null); }} type="button">{t.cancel}</button>
              </div>
            ) : (
              <div className="goals__row">
                <button className="goals__btn goals__btn--primary" onClick={() => { setAdjust({ id: g.id, direction: 'deposit' }); setAdjustAmount(''); }} type="button">{t.deposit}</button>
                <button className="goals__btn" onClick={() => { setAdjust({ id: g.id, direction: 'withdraw' }); setAdjustAmount(''); }} type="button">{t.withdraw}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default GoalsList;
