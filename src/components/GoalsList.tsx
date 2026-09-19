import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaBullseye, FaTrash } from 'react-icons/fa';
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
    saved: 'Saved',
    goalsCount: 'Goals',
    of: 'of',
    reachedCount: 'Reached',
    sectionLabel: 'Goals',
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
    saved: 'Накоплено',
    goalsCount: 'Целей',
    of: 'из',
    reachedCount: 'Достигнуто',
    sectionLabel: 'Цели',
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

  // Summary is only meaningful when every goal is in the same currency.
  const summaryCurrency = sorted.length > 0 && sorted.every(g => (g.currency || 'RUB') === (sorted[0].currency || 'RUB'))
    ? (sorted[0].currency || 'RUB')
    : null;
  const totalSaved = sorted.reduce((s, g) => s + (g.currentAmount || 0), 0);
  const totalTarget = sorted.reduce((s, g) => s + (g.targetAmount || 0), 0);
  const doneCount = sorted.filter(g => g.targetAmount > 0 && g.currentAmount >= g.targetAmount).length;

  return (
    <>
      <div className="fin-list goals">
        {/* ── Summary card ── */}
        <div className="fin-list__summary">
          <div className="fin-list__balance-label">{t.saved}</div>
          <div className="fin-list__balance-amount">
            {summaryCurrency ? formatCurrency(totalSaved, summaryCurrency, language) : `${sorted.length}`}
          </div>
          <div className="fin-list__balance-row">
            <span className="fin-list__balance-item goals__summary-item">
              {t.goalsCount}: {sorted.length}
            </span>
            {summaryCurrency && totalTarget > 0 && (
              <span className="fin-list__balance-item goals__summary-item">
                {t.of} {formatCurrency(totalTarget, summaryCurrency, language)}
              </span>
            )}
            {doneCount > 0 && (
              <span className="fin-list__balance-item fin-list__balance-item--income">
                {t.reachedCount}: {doneCount}
              </span>
            )}
          </div>
        </div>

        {error && <div className="fin-editor__error" role="alert">{error}</div>}

        {/* ── Create form ── */}
        {showForm && (
          <div className="goals__form">
            <div className="fin-editor__field-wrap">
              <label className="fin-editor__field-label">{t.title}</label>
              <input className="fin-editor__field" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} autoFocus />
            </div>
            <div className="fin-editor__field-wrap">
              <label className="fin-editor__field-label">{t.target}</label>
              <input className="fin-editor__field" type="number" inputMode="decimal" min="0" step="0.01" value={target} onChange={e => setTarget(e.target.value)} placeholder="0" />
            </div>
            <div className="fin-editor__field-wrap">
              <label className="fin-editor__field-label">{t.deadline}</label>
              <input className="fin-editor__date" type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
            </div>
            <button className="fin-editor__save-btn" disabled={busy} onClick={handleCreate} type="button">{t.create}</button>
            <button className="goals__link-btn" onClick={() => { setShowForm(false); setError(null); }} type="button">{t.cancel}</button>
          </div>
        )}

        {/* ── Goals ── */}
        {sorted.length === 0 && !showForm ? (
          <div className="fin-list__empty">
            <span className="fin-list__empty-icon"><FaBullseye /></span>
            <span className="fin-list__empty-title">{t.empty}</span>
            <span className="fin-list__empty-hint">{t.emptyHint}</span>
          </div>
        ) : (
          sorted.length > 0 && <div className="fin-list__section-label">{t.sectionLabel}</div>
        )}

        {sorted.map(g => {
          const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100)) : 0;
          const done = g.targetAmount > 0 && g.currentAmount >= g.targetAmount;
          const cur = g.currency || 'RUB';
          const isAdjusting = adjust?.id === g.id;
          return (
            <div className="goals__card" key={g.id}>
              <div className="goals__top">
                <span className="fin-list__item-icon goals__icon">
                  <span className="fin-list__item-initial">{(g.title || '?').trim().charAt(0).toUpperCase()}</span>
                </span>
                <span className="fin-list__item-body">
                  <span className="fin-list__item-title">{g.title}</span>
                  <span className="goals__sub">
                    {done ? t.reached : `${t.left} ${formatCurrency(Math.max(0, g.targetAmount - g.currentAmount), cur, language)}`}
                    {g.deadline ? ` · ${t.until} ${fmtDeadline(g.deadline)}` : ''}
                  </span>
                </span>
                <span className="fin-list__item-right">
                  <span className="fin-list__item-amount">{formatCurrency(g.currentAmount, cur, language)}</span>
                  <span className="fin-list__item-date">{t.of} {formatCurrency(g.targetAmount, cur, language)}</span>
                </span>
              </div>

              <div className="goals__bar-row">
                <div className="goals__bar"><div className={`goals__bar-fill${done ? ' goals__bar-fill--done' : ''}`} style={{ width: `${pct}%` }} /></div>
                <span className="goals__pct">{pct}%</span>
              </div>

              {isAdjusting ? (
                <div className="goals__actions">
                  <input
                    className="goals__amount-input"
                    placeholder={t.amount}
                    type="number" inputMode="decimal" min="0" step="0.01"
                    value={adjustAmount}
                    onChange={e => setAdjustAmount(e.target.value)}
                    autoFocus
                  />
                  <button className="goals__btn goals__btn--primary" disabled={busy} onClick={handleAdjust} type="button">{t.confirm}</button>
                  <button className="goals__btn" onClick={() => { setAdjust(null); setAdjustAmount(''); setError(null); }} type="button">{t.cancel}</button>
                </div>
              ) : (
                <div className="goals__actions">
                  <button className="goals__btn goals__btn--primary" onClick={() => { setAdjust({ id: g.id, direction: 'deposit' }); setAdjustAmount(''); }} type="button">{t.deposit}</button>
                  <button className="goals__btn" onClick={() => { setAdjust({ id: g.id, direction: 'withdraw' }); setAdjustAmount(''); }} type="button">{t.withdraw}</button>
                  <button className="goals__icon-btn" onClick={() => handleDelete(g.id)} aria-label={t.del} type="button"><FaTrash /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* FAB — same control as the transactions list */}
      {!showForm && (
        <button className="fab" onClick={() => { setShowForm(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }} type="button" aria-label={t.newGoal}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
    </>
  );
};

export default GoalsList;
