import React, { useEffect, useState } from 'react';
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaArrowLeft, FaArrowUp, FaArrowDown, FaTrash } from 'react-icons/fa';
import { db } from '../firebase';
import type { Currency, Transaction } from '../types/app';
import { getCurrencySymbol } from '../utils/formatCurrency';
import './Finance.css';

interface FinanceEditorProps {
  transactionId: string | null; // null = new transaction
  /** Pre-loaded transaction data from parent state — avoids a getDoc round-trip. */
  initialTransaction?: Transaction | null;
  user: User | null;
  language: 'en' | 'ru';
  currency: Currency;
  convertAmount: (amount: number) => number;
  convertToBase: (amount: number) => number;
  onBack: () => void;
}

// ── Preset categories — colored dots, no emoji ────────────────────────────────

interface PresetCat {
  id: string;
  color: string; // CSS hex color for the dot
  en: string;
  ru: string;
  type: 'income' | 'expense';
}

export const PRESET_CATS: PresetCat[] = [
  // income
  { id: 'p-salary',       color: '#4CAF50', en: 'Salary',        ru: 'Зарплата',     type: 'income'  },
  { id: 'p-freelance',    color: '#2196F3', en: 'Freelance',      ru: 'Фриланс',      type: 'income'  },
  { id: 'p-gift',         color: '#9C27B0', en: 'Gift',           ru: 'Подарок',      type: 'income'  },
  { id: 'p-other-i',      color: '#00BCD4', en: 'Other',          ru: 'Другое',       type: 'income'  },
  // expense
  { id: 'p-groceries',    color: '#FF9800', en: 'Groceries',      ru: 'Продукты',     type: 'expense' },
  { id: 'p-transport',    color: '#607D8B', en: 'Transport',      ru: 'Транспорт',    type: 'expense' },
  { id: 'p-entertainment',color: '#E91E63', en: 'Entertainment',  ru: 'Развлечения',  type: 'expense' },
  { id: 'p-health',       color: '#F44336', en: 'Health',         ru: 'Здоровье',     type: 'expense' },
  { id: 'p-subscriptions',color: '#3F51B5', en: 'Subscriptions',  ru: 'Подписки',     type: 'expense' },
  { id: 'p-food',         color: '#FF5722', en: 'Food',           ru: 'Еда',          type: 'expense' },
  { id: 'p-clothes',      color: '#795548', en: 'Clothes',        ru: 'Одежда',       type: 'expense' },
  { id: 'p-housing',      color: '#009688', en: 'Housing',        ru: 'Жильё',        type: 'expense' },
  { id: 'p-other-e',      color: '#9E9E9E', en: 'Other',          ru: 'Другое',       type: 'expense' },
];

/** Look up color by preset ID — shared with FinanceList. */
export const PRESET_COLOR_BY_ID: Record<string, string> = Object.fromEntries(
  PRESET_CATS.map(p => [p.id, p.color])
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Derive date input value (YYYY-MM-DD) from ISO string, using local time. */
function isoToDateInput(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convert date picker value (YYYY-MM-DD) to ISO string (local noon). */
function dateInputToIso(val: string): string {
  return new Date(`${val}T12:00:00`).toISOString();
}

function todayStr(): string {
  return isoToDateInput(new Date().toISOString());
}

const T = {
  en: {
    back: 'Finance',
    delete: 'Delete',
    income: 'Income',
    expense: 'Expense',
    amountHint: '0',
    descLabel: 'DESCRIPTION',
    descPlaceholder: 'What is this for?',
    dateLabel: 'DATE',
    catLabel: 'CATEGORY',
    save: 'Save Transaction',
    confirmDelete: 'Delete this transaction?',
    saving: 'Saving…',
  },
  ru: {
    back: 'Финансы',
    delete: 'Удалить',
    income: 'Доход',
    expense: 'Расход',
    amountHint: '0',
    descLabel: 'ОПИСАНИЕ',
    descPlaceholder: 'На что это?',
    dateLabel: 'ДАТА',
    catLabel: 'КАТЕГОРИЯ',
    save: 'Сохранить',
    confirmDelete: 'Удалить эту транзакцию?',
    saving: 'Сохранение…',
  },
};

// ── applyTxData ───────────────────────────────────────────────────────────────

/** Populate form fields from a transaction data object. */
function applyTxData(
  tx: { type?: 'income' | 'expense'; amount?: number; description?: string; date?: string; categoryId?: string; category?: string },
  convertAmount: (n: number) => number,
  setTxType: (v: 'income' | 'expense') => void,
  setAmountStr: (v: string) => void,
  setDescription: (v: string) => void,
  setDate: (v: string) => void,
  setSelectedCatId: (v: string) => void
) {
  if (tx.type) setTxType(tx.type);
  if (tx.amount !== undefined) {
    setAmountStr(String(Math.round(convertAmount(tx.amount) * 100) / 100));
  }
  setDescription(tx.description ?? '');
  if (tx.date) setDate(isoToDateInput(tx.date));
  // Match by ID (new-style) or by name (legacy with emoji stripped from category string)
  const catNameClean = (tx.category ?? '').replace(/^\S+\s/, ''); // strip leading non-space token
  const preset = PRESET_CATS.find(p =>
    p.id === tx.categoryId ||
    p.en.toLowerCase() === catNameClean.toLowerCase() ||
    p.ru.toLowerCase() === catNameClean.toLowerCase()
  );
  if (preset) setSelectedCatId(preset.id);
}

// ── Component ─────────────────────────────────────────────────────────────────

const FinanceEditor: React.FC<FinanceEditorProps> = ({
  transactionId,
  initialTransaction,
  user,
  language,
  currency,
  convertAmount,
  convertToBase,
  onBack,
}) => {
  const t = T[language];
  const sym = getCurrencySymbol(currency);

  const [txType, setTxType] = useState<'income' | 'expense'>('expense');
  const [amountStr, setAmountStr] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayStr());
  const [selectedCatId, setSelectedCatId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!transactionId || !!initialTransaction);

  // ── Load existing transaction ─────────────────────────────────────────────
  useEffect(() => {
    if (initialTransaction) {
      applyTxData(initialTransaction, convertAmount, setTxType, setAmountStr, setDescription, setDate, setSelectedCatId);
      return;
    }
    if (!transactionId) return;
    getDoc(doc(db, 'transactions', transactionId))
      .then(snap => {
        if (snap.exists()) {
          applyTxData(snap.data(), convertAmount, setTxType, setAmountStr, setDescription, setDate, setSelectedCatId);
        }
        setLoaded(true);
      })
      .catch(err => {
        console.warn('FinanceEditor load error', err);
        setLoaded(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const visibleCats = PRESET_CATS.filter(c => c.type === txType);
  const catDisplayName = (p: PresetCat) => language === 'ru' ? p.ru : p.en;

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!user) return;
    const amount = parseFloat(amountStr);
    if (!amountStr || isNaN(amount) || amount <= 0) {
      alert(language === 'ru' ? 'Введите корректную сумму' : 'Enter a valid amount');
      return;
    }
    const preset = PRESET_CATS.find(p => p.id === selectedCatId);
    const id = transactionId ?? makeId();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        id,
        userId: user.uid,
        type: txType,
        amount: convertToBase(amount),
        description: description.trim(),
        date: dateInputToIso(date),
        categoryId: preset?.id ?? '',
        // Store plain name (no emoji) — FinanceList uses PRESET_COLOR_BY_ID for color
        category: preset ? catDisplayName(preset) : '',
        updatedAt: serverTimestamp(),
      };
      if (!transactionId) {
        payload.createdAt = serverTimestamp();
      }
      await setDoc(doc(db, 'transactions', id), payload, { merge: true });
      onBack();
    } catch (err) {
      console.warn('FinanceEditor save error', err);
      setSaving(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!transactionId) { onBack(); return; }
    if (!window.confirm(t.confirmDelete)) return;
    try {
      await deleteDoc(doc(db, 'transactions', transactionId));
    } catch (err) {
      console.warn('FinanceEditor delete error', err);
    }
    onBack();
  };

  if (!loaded) {
    return (
      <div className="fin-editor">
        <div className="fin-editor__toolbar">
          <button className="fin-editor__back-btn" onClick={onBack} type="button">
            <FaArrowLeft /> {t.back}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fin-editor">
      {/* ── Toolbar ── */}
      <div className="fin-editor__toolbar">
        <button className="fin-editor__back-btn" onClick={onBack} type="button">
          <FaArrowLeft /> {t.back}
        </button>
        {transactionId && (
          <button className="fin-editor__del-btn" onClick={handleDelete} type="button">
            <FaTrash /> {t.delete}
          </button>
        )}
      </div>

      {/* ── Income / Expense toggle — SVG arrows ── */}
      <div className="fin-editor__type-toggle">
        <button
          className={`fin-editor__type-btn${txType === 'income' ? ' fin-editor__type-btn--income' : ''}`}
          onClick={() => { setTxType('income'); setSelectedCatId(''); }}
          type="button"
        >
          <FaArrowUp className="fin-editor__type-icon" /> {t.income}
        </button>
        <button
          className={`fin-editor__type-btn${txType === 'expense' ? ' fin-editor__type-btn--expense' : ''}`}
          onClick={() => { setTxType('expense'); setSelectedCatId(''); }}
          type="button"
        >
          <FaArrowDown className="fin-editor__type-icon" /> {t.expense}
        </button>
      </div>

      {/* ── Amount ── */}
      <div className="fin-editor__amount-wrap">
        <span className="fin-editor__amount-symbol">{sym}</span>
        <input
          className="fin-editor__amount-input"
          type="number"
          inputMode="decimal"
          placeholder={t.amountHint}
          value={amountStr}
          onChange={e => setAmountStr(e.target.value)}
          min="0"
          step="0.01"
        />
      </div>

      {/* ── Category — colored dot chips ── */}
      <div className="fin-editor__section-label">{t.catLabel}</div>
      <div className="fin-editor__cats">
        {visibleCats.map(p => {
          const isActive = selectedCatId === p.id;
          const activeClass = txType === 'income'
            ? 'fin-editor__cat--income-active'
            : 'fin-editor__cat--expense-active';
          return (
            <button
              key={p.id}
              className={`fin-editor__cat${isActive ? ` ${activeClass}` : ''}`}
              onClick={() => setSelectedCatId(isActive ? '' : p.id)}
              type="button"
            >
              <span className="fin-editor__cat-dot" style={{ backgroundColor: p.color }} />
              {catDisplayName(p)}
            </button>
          );
        })}
      </div>

      {/* ── Description ── */}
      <div className="fin-editor__field-wrap">
        <span className="fin-editor__field-label">{t.descLabel}</span>
        <input
          className="fin-editor__field"
          type="text"
          placeholder={t.descPlaceholder}
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </div>

      {/* ── Date ── */}
      <div className="fin-editor__field-wrap">
        <span className="fin-editor__field-label">{t.dateLabel}</span>
        <input
          className="fin-editor__date"
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
        />
      </div>

      {/* ── Save ── */}
      <button
        className="fin-editor__save-btn"
        onClick={handleSave}
        disabled={saving}
        type="button"
      >
        {saving ? t.saving : t.save}
      </button>
    </div>
  );
};

export default FinanceEditor;
