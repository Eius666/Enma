import React, { useMemo, useState } from 'react';
import { FaSearch, FaArrowUp, FaArrowDown, FaWallet } from 'react-icons/fa';
import { isToday, isYesterday, format } from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import type { Transaction, Category, Currency } from '../types/app';
import { PRESET_COLOR_BY_ID } from './FinanceEditor';
import './Finance.css';

interface FinanceListProps {
  language: 'en' | 'ru';
  currency: Currency;
  convertAmount: (amount: number) => number;
  categories: Category[];
  transactions: Transaction[];
  onOpenEditor: (txId: string | null) => void;
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
function getCatInitial(label: string, type: 'income' | 'expense'): string {
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

function txTimeLabel(isoStr: string): string {
  const d = new Date(isoStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const T = {
  en: {
    balance: 'Balance',
    income: 'Income',
    expense: 'Expenses',
    search: 'Search transactions…',
    all: 'All',
    emptyTitle: 'No transactions yet',
    emptyHint: 'Tap + to add a transaction',
    emptySearchTitle: 'Nothing found',
    emptySearchHint: 'Try a different search',
    newTx: 'New transaction',
  },
  ru: {
    balance: 'Баланс',
    income: 'Доход',
    expense: 'Расходы',
    search: 'Поиск операций…',
    all: 'Все',
    emptyTitle: 'Операций пока нет',
    emptyHint: 'Нажмите + чтобы добавить',
    emptySearchTitle: 'Ничего не найдено',
    emptySearchHint: 'Попробуйте другой запрос',
    newTx: 'Новая операция',
  },
};

const FinanceList: React.FC<FinanceListProps> = ({
  language,
  currency,
  convertAmount,
  categories,
  transactions,
  onOpenEditor,
}) => {
  const t = T[language];
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';

  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(t.all);
  const [activeBank, setActiveBank] = useState<string | null>(null);

  // For summary totals (always in USD base).
  const fmt = (amount: number) =>
    convertAmount(amount).toLocaleString(locale, { style: 'currency', currency });

  // For individual transactions: prefer originalAmount when currencies match to avoid
  // precision loss from the USD roundtrip (e.g. 500 RUB → 5.56 USD → 499.7 RUB).
  const fmtTx = (tx: Transaction) => {
    if (tx.originalCurrency === currency && tx.originalAmount != null) {
      return tx.originalAmount.toLocaleString(locale, { style: 'currency', currency });
    }
    return fmt(tx.amount);
  };

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const income = transactions
      .filter(tx => tx.type === 'income')
      .reduce((s, tx) => s + tx.amount, 0);
    const expense = transactions
      .filter(tx => tx.type === 'expense')
      .reduce((s, tx) => s + tx.amount, 0);
    return { income, expense, balance: income - expense };
  }, [transactions]);

  // ── Category chips (derived from transactions) ─────────────────────────────
  const chips = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [t.all];
    for (const tx of transactions) {
      const label = resolveCatLabel(tx, categories);
      if (label && !seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
    return result;
  }, [transactions, categories, t.all]);

  const safeActiveCategory = chips.includes(activeCategory) ? activeCategory : t.all;

  // ── Banks that appear in actual transactions ───────────────────────────────
  const txBanks = useMemo(() => {
    const seen = new Set<string>();
    for (const tx of transactions) {
      if (tx.bank) seen.add(tx.bank);
    }
    return Array.from(seen);
  }, [transactions]);

  // ── Filtered transactions ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter(tx => {
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
  }, [transactions, categories, safeActiveCategory, activeBank, searchQuery, t.all]);

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
        </div>
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
                      {isIncome ? '+' : '−'}{fmtTx(tx)}
                    </span>
                    <span className="fin-list__item-date">{txTimeLabel(tx.date)}</span>
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
