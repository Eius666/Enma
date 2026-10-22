import React, { useEffect, useMemo, useState } from 'react';
import { FaSearch, FaArrowUp, FaArrowDown, FaWallet, FaBullseye } from 'react-icons/fa';
import { isToday, isYesterday, format } from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { User } from 'firebase/auth';
import { db } from '../firebase';
import type { Transaction, Category, Currency } from '../types/app';
import { PRESET_COLOR_BY_ID } from './FinanceEditor';
import { getBudgetAmount, getOriginalCurrency } from '../utils/budgetAmount';
import { compareNewestFirst } from '../utils/sortTransactions';
import { convertCurrency } from '../utils/convertCurrency';
import './Finance.css';

interface FinanceListProps {
  language: 'en' | 'ru';
  currency: Currency;
  rates: Record<string, number>;
  categories: Category[];
  transactions: Transaction[];
  user: User | null;
  /** Shown between the search and the category chips (the PDF report button). */
  reportButton?: React.ReactNode;
  onOpenEditor: (txId: string | null) => void;
}

/** Whether a transaction is a goal transfer — never real income/expense. */
function isGoalTransfer(tx: Transaction): boolean {
  return tx.type === 'goal_deposit' || tx.type === 'goal_withdraw';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve human-readable category label.
 * - New transactions store plain name in tx.category (e.g. "Groceries")
 * - Legacy transactions may have emoji prefix ("🛒 Groceries") — we strip it
 * - Oldest transactions have no tx.category, only categoryId — resolve via categories[]
 */
function resolveCatLabel(tx: Transaction, categories: Category[]): string {
  if (tx.category) {
    const label = tx.category;
    // Strip legacy emoji prefix: if first non-space token has a high codepoint, remove it
    const spaceIdx = label.indexOf(' ');
    if (spaceIdx > 0) {
      const first = label.slice(0, spaceIdx);
      if ((first.codePointAt(0) ?? 0) > 127) {
        return label.slice(spaceIdx + 1).trim();
      }
    }
    return label;
  }
  const c = categories.find(c => c.id === tx.categoryId);
  return c?.name ?? '';
}

/**
 * Get category dot color.
 * 1. Look up by preset ID (new-style transactions)
 * 2. Deterministic color from category string (legacy)
 */
const FALLBACK_COLORS = ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#607D8B', '#9C27B0', '#FF5722'];

function getCatColor(tx: Transaction): string {
  if (tx.categoryId && PRESET_COLOR_BY_ID[tx.categoryId]) {
    return PRESET_COLOR_BY_ID[tx.categoryId];
  }
  const key = tx.categoryId || tx.category || '';
  if (!key) return tx.type === 'income' ? '#4CAF50' : '#FF9800';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffff;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

/** First letter of the category label (for the colored circle). */
function getCatInitial(label: string, type: Transaction['type']): string {
  if (!label) return type === 'income' ? 'I' : 'E';
  return label.charAt(0).toUpperCase();
}

function txDateLabel(isoStr: string, language: 'en' | 'ru'): string {
  const d = new Date(isoStr);
  if (isToday(d)) return language === 'ru' ? 'Сегодня' : 'Today';
  if (isYesterday(d)) return language === 'ru' ? 'Вчера' : 'Yesterday';
  return format(d, language === 'ru' ? 'd MMMM' : 'MMMM d', {
    locale: language === 'ru' ? ruLocale : enUS,
  });
}

// Real time of the operation. Older web rows were stored as a fake local noon
// (12:00:00.000) — for those fall back to the creation time when it is from the
// same day, otherwise show no time rather than a wrong one.
function txTimeLabel(tx: Transaction): string | null {
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const d = new Date(tx.date);
  if (Number.isNaN(d.getTime())) return null;
  const isNoonPlaceholder =
    d.getHours() === 12 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  if (!isNoonPlaceholder) return fmt(d);

  const c = tx.createdAt as { toMillis?: () => number } | number | null | undefined;
  const ms = typeof c === 'number' ? c : c && typeof c.toMillis === 'function' ? c.toMillis() : NaN;
  if (Number.isFinite(ms)) {
    const created = new Date(ms);
    if (created.toDateString() === d.toDateString()) return fmt(created);
  }
  return null;
}

type Period = 'day' | 'week' | 'month' | 'all';

const T = {
  en: {
    balance: 'Balance',
    income: 'Income',
    expense: 'Expenses',
    saved: 'Saved',
    search: 'Search transactions…',
    all: 'All',
    emptyTitle: 'No transactions yet',
    emptyHint: 'Tap + to add a transaction',
    emptySearchTitle: 'Nothing found',
    emptySearchHint: 'Try a different search',
    newTx: 'New transaction',
    periodDay: 'Today',
    periodWeek: 'Week',
    periodMonth: 'Month',
    periodAll: 'All time',
    goalContribution: 'Savings',
    goalWithdrawal: 'Savings',
    goalContributionSub: 'Transferred to savings',
    goalWithdrawalSub: 'Returned from savings',
    goalInfoClose: 'Close',
  },
  ru: {
    balance: 'Баланс',
    income: 'Доход',
    expense: 'Расходы',
    saved: 'Отложено',
    search: 'Поиск операций…',
    all: 'Все',
    emptyTitle: 'Операций пока нет',
    emptyHint: 'Нажмите + чтобы добавить',
    emptySearchTitle: 'Ничего не найдено',
    emptySearchHint: 'Попробуйте другой запрос',
    newTx: 'Новая операция',
    periodDay: 'День',
    periodWeek: 'Неделя',
    periodMonth: 'Месяц',
    periodAll: 'Всё время',
    goalContribution: 'Накопления',
    goalWithdrawal: 'Накопления',
    goalContributionSub: 'Перевод в копилку',
    goalWithdrawalSub: 'Возврат из копилки',
    goalInfoClose: 'Закрыть',
  },
};

const FinanceList: React.FC<FinanceListProps> = ({
  language,
  currency,
  rates,
  categories,
  transactions,
  user,
  reportButton,
  onOpenEditor,
}) => {
  const t = T[language];
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';

  const [searchQuery, setSearchQuery] = useState('');
  const [period, setPeriod] = useState<Period>('month');
  const [activeCategory, setActiveCategory] = useState(t.all);
  const [activeBank, setActiveBank] = useState<string | null>(null);
  const [goalInfoTxId, setGoalInfoTxId] = useState<string | null>(null);

  // Independent subscription (same pattern as GoalsList) — only reads
  // currentAmount(Rub)/currency, purely for the compact "Отложено" line
  // below; never written to from here.
  const [goals, setGoals] = useState<{ currentAmount: number; currentAmountRub?: number; currency?: string }[]>([]);
  useEffect(() => {
    if (!user) { setGoals([]); return; }
    const q = query(collection(db, 'goals'), where('userId', '==', user.uid));
    return onSnapshot(
      q,
      snap => setGoals(snap.docs.map(d => d.data() as { currentAmount: number; currentAmountRub?: number; currency?: string })),
      err => console.warn('FinanceList goals listener error', err),
    );
  }, [user]);

  // currentAmountRub is the RUB cost basis maintained atomically by
  // api/_lib/finance/goalTransfer.js (every real transfer's LOCKED
  // rubAmount, summed) — it never drifts just because today's exchange
  // rate moved, so an ordinary FX fluctuation never shows up here as
  // "phantom profit" in Total Funds. The live conversion below is a
  // fallback ONLY for a legacy goal that predates this field and hasn't
  // been touched (deposited/withdrawn into) since — the very first
  // transfer into it locks a one-time baseline and it never needs a live
  // rate again. A never-touched legacy goal's figure can still drift with
  // FX until that first touch; there's no way to avoid that without
  // inventing a rate for a moment nobody actually transacted at.
  const savingsBalance = useMemo(
    () => goals.reduce((s, g) => {
      const rub = typeof g.currentAmountRub === 'number'
        ? g.currentAmountRub
        : convertCurrency(g.currentAmount || 0, g.currency || 'RUB', 'RUB', rates);
      return s + convertCurrency(rub, 'RUB', currency, rates);
    }, 0),
    [goals, currency, rates],
  );

  // Filter transactions by selected period first; everything else derives from this.
  // Always newest first (top = most recent), whatever order the data arrives in.
  const sortedTransactions = useMemo(
    () => [...transactions].sort(compareNewestFirst),
    [transactions],
  );

  const periodFiltered = useMemo((): Transaction[] => {
    if (period === 'all') return sortedTransactions;
    const now = new Date();
    const start = new Date();
    if (period === 'day') {
      start.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
    return sortedTransactions.filter(tx => new Date(tx.date) >= start);
  }, [sortedTransactions, period]);

  // Budget is always RUB. Every transaction contributes its budget amount:
  // v2 rows → the ruble value LOCKED at creation (never re-priced with today's
  // FX); legacy rows → resolved currency converted at read time. Rows and
  // aggregates share this one function so they can never disagree. Returns
  // null when a legacy record's currency can't be determined — excluded from
  // totals rather than mis-summed.
  const getDisplayAmount = React.useCallback(
    (tx: Transaction): number | null => getBudgetAmount(tx, rates),
    [rates],
  );

  const formatMoney = (amount: number, cur: string = currency) =>
    amount.toLocaleString(locale, { style: 'currency', currency: cur });

  const fmt = (amount: number) => formatMoney(amount);

  // Row amount: the operation's REAL currency first ("− $50"), with the
  // budget value as a secondary "≈ 4 300 ₽" for foreign operations. RUB rows
  // show a single figure.
  const txAmountParts = (tx: Transaction): { primary: string; secondary: string | null } => {
    const budget = getDisplayAmount(tx);
    const orig = getOriginalCurrency(tx);
    if (orig === null || budget === null) return { primary: '—', secondary: null };
    if (orig === currency) return { primary: formatMoney(tx.amount, orig), secondary: null };
    return {
      primary: formatMoney(tx.amount, orig),
      secondary: `≈ ${formatMoney(budget)}`,
    };
  };

  // ── Summary (for selected period) ─────────────────────────────────────────
  const summary = useMemo(() => {
    const income = periodFiltered
      .filter(tx => tx.type === 'income')
      .reduce((s, tx) => s + (getDisplayAmount(tx) ?? 0), 0);
    const expense = periodFiltered
      .filter(tx => tx.type === 'expense')
      .reduce((s, tx) => s + (getDisplayAmount(tx) ?? 0), 0);
    return { income, expense, balance: income - expense };
  }, [periodFiltered, getDisplayAmount]);

  // ── Category chips (derived from period-filtered transactions) ─────────────
  const chips = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [t.all];
    for (const tx of periodFiltered) {
      const label = resolveCatLabel(tx, categories);
      if (label && !seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
    return result;
  }, [periodFiltered, categories, t.all]);

  const safeActiveCategory = chips.includes(activeCategory) ? activeCategory : t.all;

  // ── Banks that appear in period-filtered transactions ──────────────────────
  const txBanks = useMemo(() => {
    const seen = new Set<string>();
    for (const tx of periodFiltered) {
      if (tx.bank) seen.add(tx.bank);
    }
    return Array.from(seen);
  }, [periodFiltered]);

  // ── Filtered transactions (category + bank + search on top of period) ──────
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return periodFiltered.filter(tx => {
      const label = resolveCatLabel(tx, categories);
      if (safeActiveCategory !== t.all && label !== safeActiveCategory) return false;
      if (activeBank !== null && tx.bank !== activeBank) return false;
      if (q) {
        return (
          tx.description.toLowerCase().includes(q) ||
          label.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [periodFiltered, categories, safeActiveCategory, activeBank, searchQuery, t.all]);

  // ── Date grouping ──────────────────────────────────────────────────────────
  type Group = { label: string; items: Transaction[] };

  const groups = useMemo((): Group[] => {
    const map = new Map<string, Transaction[]>();
    const order: string[] = [];
    for (const tx of filtered) {
      const label = txDateLabel(tx.date, language);
      if (!map.has(label)) {
        map.set(label, []);
        order.push(label);
      }
      map.get(label)!.push(tx);
    }
    return order.map(l => ({ label: l, items: map.get(l)! }));
  }, [filtered, language]);

  const isEmpty = filtered.length === 0;

  return (
    <>
    <div className="fin-list">
      {/* ── Balance summary ── */}
      <div className="fin-list__summary">
        <div className="fin-list__balance-label">{t.balance}</div>
        <div className="fin-list__balance-amount">{fmt(summary.balance)}</div>
        <div className="fin-list__balance-row">
          <span className="fin-list__balance-item fin-list__balance-item--income">
            <FaArrowUp className="fin-list__balance-arrow" />
            {t.income}: {fmt(summary.income)}
          </span>
          <span className="fin-list__balance-item fin-list__balance-item--expense">
            <FaArrowDown className="fin-list__balance-arrow" />
            {t.expense}: {fmt(summary.expense)}
          </span>
          {savingsBalance > 0 && (
            <span className="fin-list__balance-item fin-list__balance-item--saved">
              <FaBullseye className="fin-list__balance-arrow" />
              {t.saved}: {fmt(savingsBalance)}
            </span>
          )}
        </div>
      </div>

      {/* ── Period chips ── */}
      <div className="fin-list__period-wrap">
        {(['day', 'week', 'month', 'all'] as Period[]).map(p => (
          <button
            key={p}
            className={`fin-list__period-chip${period === p ? ' fin-list__period-chip--active' : ''}`}
            onClick={() => setPeriod(p)}
            type="button"
          >
            {p === 'day' ? t.periodDay
              : p === 'week' ? t.periodWeek
              : p === 'month' ? t.periodMonth
              : t.periodAll}
          </button>
        ))}
      </div>

      {/* ── Search ── */}
      <div className="fin-list__search-wrap">
        <FaSearch className="fin-list__search-icon" />
        <input
          className="fin-list__search"
          type="text"
          placeholder={t.search}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {reportButton}

      {/* ── Category chips ── */}
      <div className="fin-list__chips-wrap">
        <div className="fin-list__chips">
          {chips.map(chip => (
            <button
              key={chip}
              className={`fin-list__chip${safeActiveCategory === chip ? ' fin-list__chip--active' : ''}`}
              onClick={() => setActiveCategory(chip)}
              type="button"
            >
              {chip}
            </button>
          ))}
        </div>
      </div>

      {/* ── Bank filter chips ── */}
      {txBanks.length > 0 && (
        <div className="fin-list__bank-wrap">
          <button
            className={`fin-list__bank-chip${activeBank === null ? ' fin-list__bank-chip--active' : ''}`}
            onClick={() => setActiveBank(null)}
            type="button"
          >
            {t.all}
          </button>
          {txBanks.map(bank => (
            <button
              key={bank}
              className={`fin-list__bank-chip${activeBank === bank ? ' fin-list__bank-chip--active' : ''}`}
              onClick={() => setActiveBank(activeBank === bank ? null : bank)}
              type="button"
            >
              {bank}
            </button>
          ))}
        </div>
      )}

      {/* ── Transaction list ── */}
      {isEmpty ? (
        <div className="fin-list__empty">
          {/* SVG wallet icon — no emoji */}
          <span className="fin-list__empty-icon">
            <FaWallet />
          </span>
          <span className="fin-list__empty-title">
            {searchQuery ? t.emptySearchTitle : t.emptyTitle}
          </span>
          <span className="fin-list__empty-hint">
            {searchQuery ? t.emptySearchHint : t.emptyHint}
          </span>
        </div>
      ) : (
        groups.map(({ label, items }) => (
          <React.Fragment key={label}>
            <div className="fin-list__section-label">{label}</div>
            {items.map(tx => {
              // Goal transfers (api/_lib/finance/goalTransfer.js) get their own
              // row shape — never routed into the generic FinanceEditor
              // (PHASE 11: money fields of a linked transaction must not be
              // editable independently of the goal itself; Firestore rules
              // enforce this server-side too). Clicking shows a small inline
              // info disclosure instead of opening an editor.
              if (isGoalTransfer(tx)) {
                const isWithdrawal = tx.type === 'goal_withdraw';
                const goalTitle = tx.goalTitleSnapshot || (language === 'ru' ? 'Цель' : 'Goal');
                const infoOpen = goalInfoTxId === tx.id;
                return (
                  <React.Fragment key={tx.id}>
                    <button
                      className="fin-list__item"
                      onClick={() => setGoalInfoTxId(infoOpen ? null : tx.id)}
                      type="button"
                      aria-expanded={infoOpen}
                    >
                      <span className="fin-list__item-icon fin-list__item-icon--goal">
                        <FaBullseye />
                      </span>
                      <span className="fin-list__item-body">
                        <span className="fin-list__item-title">
                          {(isWithdrawal ? t.goalWithdrawal : t.goalContribution)} · {goalTitle}
                        </span>
                        <span className="fin-list__item-meta">
                          <span className="fin-list__item-cat">
                            {isWithdrawal ? t.goalWithdrawalSub : t.goalContributionSub}
                          </span>
                        </span>
                      </span>
                      <span className="fin-list__item-right">
                        <span className="fin-list__item-amount fin-list__item-amount--goal">
                          {isWithdrawal ? '+' : '−'}{txAmountParts(tx).primary}
                        </span>
                        {txAmountParts(tx).secondary && (
                          <span className="fin-list__item-approx">{txAmountParts(tx).secondary}</span>
                        )}
                        {txTimeLabel(tx) && (
                          <span className="fin-list__item-date">{txTimeLabel(tx)}</span>
                        )}
                      </span>
                    </button>
                    {infoOpen && (
                      <div className="fin-list__goal-info">
                        <FaBullseye className="fin-list__goal-info-icon" />
                        <span className="fin-list__goal-info-text">
                          {goalTitle} — {isWithdrawal ? '+' : '−'}{txAmountParts(tx).primary}
                        </span>
                        <button
                          className="fin-list__goal-info-close"
                          onClick={() => setGoalInfoTxId(null)}
                          type="button"
                        >
                          {t.goalInfoClose}
                        </button>
                      </div>
                    )}
                  </React.Fragment>
                );
              }

              const catLabel = resolveCatLabel(tx, categories);
              const color = getCatColor(tx);
              const initial = getCatInitial(catLabel, tx.type);
              const isIncome = tx.type === 'income';
              return (
                <button
                  key={tx.id}
                  className="fin-list__item"
                  onClick={() => onOpenEditor(tx.id)}
                  type="button"
                >
                  {/* Colored circle with initial letter — no emoji */}
                  <span className="fin-list__item-icon" style={{ backgroundColor: color }}>
                    <span className="fin-list__item-initial">{initial}</span>
                  </span>
                  <span className="fin-list__item-body">
                    <span className="fin-list__item-title">
                      {tx.description || (language === 'ru' ? 'Без описания' : 'No description')}
                    </span>
                    <span className="fin-list__item-meta">
                      {catLabel && (
                        <span className="fin-list__item-cat">{catLabel}</span>
                      )}
                      {tx.bank && (
                        <span className="fin-list__item-bank">{tx.bank}</span>
                      )}
                    </span>
                  </span>
                  <span className="fin-list__item-right">
                    <span className={`fin-list__item-amount fin-list__item-amount--${tx.type}`}>
                      {isIncome ? '+' : '−'}{txAmountParts(tx).primary}
                    </span>
                    {txAmountParts(tx).secondary && (
                      <span className="fin-list__item-approx">{txAmountParts(tx).secondary}</span>
                    )}
                    {txTimeLabel(tx) && (
                      <span className="fin-list__item-date">{txTimeLabel(tx)}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </React.Fragment>
        ))
      )}

    </div>

    {/* FAB — outside animated container so position:fixed isn't affected by transform */}
    <button
      className="fab"
      onClick={() => onOpenEditor(null)}
      type="button"
      aria-label={t.newTx}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    </>
  );
};

export default FinanceList;
