import React, { useMemo, useState } from 'react';
import { FaSearch, FaPlus, FaArrowUp, FaArrowDown } from 'react-icons/fa';
import { isToday, isYesterday, format } from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import type { Transaction, Category, Currency } from '../types/app';
import { getCurrencySymbol } from '../utils/formatCurrency';
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

function resolveCatLabel(tx: Transaction, categories: Category[]): string {
  if (tx.category) return tx.category;
  const c = categories.find(c => c.id === tx.categoryId);
  return c?.name ?? '';
}

// Labels from FinanceEditor are formatted as "🛒 Name" – emoji + space + text.
function catEmoji(label: string, type: 'income' | 'expense'): string {
  if (!label) return type === 'income' ? '💰' : '💸';
  const spaceIdx = label.indexOf(' ');
  if (spaceIdx > 0) {
    const first = label.slice(0, spaceIdx);
    if ((first.codePointAt(0) ?? 0) > 127) return first;
  }
  return type === 'income' ? '💰' : '💸';
}

function catName(label: string): string {
  if (!label) return '';
  const spaceIdx = label.indexOf(' ');
  if (spaceIdx > 0) {
    const first = label.slice(0, spaceIdx);
    if ((first.codePointAt(0) ?? 0) > 127) return label.slice(spaceIdx + 1);
  }
  return label;
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
  const sym = getCurrencySymbol(currency);
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';

  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(t.all);

  const fmt = (amount: number) =>
    convertAmount(amount).toLocaleString(locale, { style: 'currency', currency });

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

  // ── Category chips (derived) ───────────────────────────────────────────────
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

  // Reset active category to "All" when chips change and it's no longer valid
  const safeActiveCategory = chips.includes(activeCategory) ? activeCategory : t.all;

  // ── Filtered transactions ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter(tx => {
      const label = resolveCatLabel(tx, categories);
      if (safeActiveCategory !== t.all && label !== safeActiveCategory) return false;
      if (q) {
        return (
          tx.description.toLowerCase().includes(q) ||
          label.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [transactions, categories, safeActiveCategory, searchQuery, t.all]);

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

      {/* ── Transaction list ── */}
      {isEmpty ? (
        <div className="fin-list__empty">
          <span className="fin-list__empty-icon">{sym}</span>
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
              const emoji = catEmoji(catLabel, tx.type);
              const name  = catName(catLabel);
              const isIncome = tx.type === 'income';
              return (
                <button
                  key={tx.id}
                  className="fin-list__item"
                  onClick={() => onOpenEditor(tx.id)}
                  type="button"
                >
                  <span className="fin-list__item-icon">{emoji}</span>
                  <span className="fin-list__item-body">
                    <span className="fin-list__item-title">
                      {tx.description || (language === 'ru' ? 'Без описания' : 'No description')}
                    </span>
                    {name && (
                      <span className="fin-list__item-cat">{name}</span>
                    )}
                  </span>
                  <span className="fin-list__item-right">
                    <span className={`fin-list__item-amount fin-list__item-amount--${tx.type}`}>
                      {isIncome ? '+' : '−'}{fmt(tx.amount)}
                    </span>
                    <span className="fin-list__item-date">{txTimeLabel(tx.date)}</span>
                  </span>
                </button>
              );
            })}
          </React.Fragment>
        ))
      )}

      {/* ── FAB ── */}
      <button
        className="fin-list__fab"
        onClick={() => onOpenEditor(null)}
        type="button"
        aria-label={t.newTx}
      >
        <FaPlus />
      </button>
    </div>
  );
};

export default FinanceList;
