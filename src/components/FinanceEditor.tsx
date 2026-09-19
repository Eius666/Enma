import React, { useEffect, useState } from 'react';
import {
  doc,
  getDoc,
  deleteDoc,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { FaArrowLeft, FaArrowUp, FaArrowDown, FaTrash } from 'react-icons/fa';
import { db } from '../firebase';
import type { Currency, Transaction } from '../types/app';
import { getCurrencySymbol, formatCurrency } from '../utils/formatCurrency';
import { resolveTransactionCurrency } from '../utils/resolveLegacyCurrency';
import { hasLockedRub, isEstimatedRate } from '../utils/budgetAmount';
import type { Subscription } from '../subscription';
import { getActivePlan, FREE_LIMITS } from '../subscription';
import { subscribeFreeUsage } from '../lib/usageCounters';
import Paywall, { LimitBanner } from './Paywall';
import './Finance.css';

interface FinanceEditorProps {
  transactionId: string | null;
  initialTransaction?: Transaction | null;
  user: User | null;
  language: 'en' | 'ru';
  // user.currency — the currency NEW operations are entered in. Not the
  // budget currency (always RUB) and never applied to existing history.
  inputCurrency: Currency;
  banks: string[];
  subscription?: Subscription | null;
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

/**
 * Convert the date picker value (YYYY-MM-DD) to an ISO timestamp: the chosen
 * day at the CURRENT local time of day. The picker has no time field, so the
 * moment of entry is the best real time we have (for "today" it is exactly now).
 * Never a fake "noon".
 */
function dateInputToIso(val: string, now: Date = new Date()): string {
  const [y, m, d] = val.split('-').map(Number);
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).toISOString();
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
    bankLabel: 'BANK / PAYMENT METHOD',
    save: 'Save Transaction',
    confirmDelete: 'Delete this transaction?',
    saving: 'Saving…',
    detailsAmount: 'Amount',
    detailsInBudget: 'In budget',
    detailsRate: 'Rate',
    detailsSource: 'Source',
    detailsCaptured: 'Locked at',
    sourceBank: 'average bank rate',
    sourceEstimate: 'estimated rate',
    fxUnavailable: 'Could not get a reliable exchange rate. The transaction was not saved — try again later or enter it in rubles.',
    saveFailed: 'Could not save the transaction. Try again.',
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
    bankLabel: 'БАНК / МЕТОД ОПЛАТЫ',
    save: 'Сохранить',
    confirmDelete: 'Удалить эту транзакцию?',
    saving: 'Сохранение…',
    detailsAmount: 'Сумма',
    detailsInBudget: 'В бюджете',
    detailsRate: 'Курс',
    detailsSource: 'Источник',
    detailsCaptured: 'Зафиксирован',
    sourceBank: 'средний банковский курс',
    sourceEstimate: 'оценочный курс',
    fxUnavailable: 'Не удалось получить надёжный курс. Операция не сохранена — попробуйте позже или введите сумму в рублях.',
    saveFailed: 'Не удалось сохранить операцию. Попробуйте ещё раз.',
  },
};

const LAST_BANK_KEY = 'enma.lastBank';

// ── applyTxData ───────────────────────────────────────────────────────────────

/** Populate form fields from a transaction data object. */
function applyTxData(
  tx: {
    type?: 'income' | 'expense'; amount?: number; currency?: string; source?: string;
    createdAt?: { toMillis?: () => number; toDate?: () => Date } | number | null;
    description?: string; date?: string; categoryId?: string; category?: string; bank?: string;
  },
  setTxType: (v: 'income' | 'expense') => void,
  setAmountStr: (v: string) => void,
  setTxCurrency: (v: Currency) => void,
  setDescription: (v: string) => void,
  setDate: (v: string) => void,
  setSelectedCatId: (v: string) => void,
  setSelectedBank: (v: string) => void,
  fallbackCurrency: Currency,
) {
  if (tx.type) setTxType(tx.type);
  if (tx.amount !== undefined) {
    // Edit the amount in the transaction's OWN currency — never convert it
    // into the app's current display currency. Converting here would silently
    // re-denominate stored history the moment the user hits Save.
    setAmountStr(String(Math.round(tx.amount * 100) / 100));
  }
  // Legacy records without a currency field are resolved via their real
  // historical write-path semantics — never guessed as a blanket default.
  // A genuinely unresolvable record (rare — see resolveLegacyCurrency.ts)
  // falls back to the current input currency purely so the editor has
  // something to show; this is a last-resort UI default, not a claim about
  // the record's real history.
  const resolved = resolveTransactionCurrency(tx);
  setTxCurrency((resolved.currency as Currency) || fallbackCurrency);
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
  if (tx.bank) setSelectedBank(tx.bank);
}

// ── Component ─────────────────────────────────────────────────────────────────

const FinanceEditor: React.FC<FinanceEditorProps> = ({
  transactionId,
  initialTransaction,
  user,
  language,
  inputCurrency,
  banks,
  subscription,
  onBack,
}) => {
  const t = T[language];
  const isNew = !transactionId;

  const [txType, setTxType] = useState<'income' | 'expense'>('expense');
  const [amountStr, setAmountStr] = useState('');
  // The currency THIS transaction is denominated in. New transactions use the
  // user's current input currency (user.currency); existing transactions keep
  // their own stored currency — switching the input currency never touches
  // history.
  const [txCurrency, setTxCurrency] = useState<Currency>(inputCurrency);
  // Raw stored doc of an existing transaction — drives the details block.
  const [existingTx, setExistingTx] = useState<Transaction | null>(initialTransaction ?? null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const sym = getCurrencySymbol(txCurrency);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayStr());
  const [selectedCatId, setSelectedCatId] = useState<string>('');
  const [selectedBank, setSelectedBank] = useState<string>(
    () => (transactionId ? '' : (localStorage.getItem(LAST_BANK_KEY) ?? ''))
  );
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!transactionId || !!initialTransaction);
  const [showPaywall, setShowPaywall] = useState(false);
  const [usedTx, setUsedTx] = useState<number | null>(null);

  const plan   = getActivePlan(subscription ?? null);
  const isFree = plan === 'free';
  const limit  = FREE_LIMITS.monthlyTransactions;
  const near80 = usedTx !== null && usedTx >= Math.floor(limit * 0.8);

  useEffect(() => {
    if (!user || !isFree) return;
    return subscribeFreeUsage(user.uid, d => setUsedTx(d.transactionCount));
  }, [user, isFree]);

  // ── Load existing transaction ─────────────────────────────────────────────
  useEffect(() => {
    if (initialTransaction) {
      applyTxData(initialTransaction, setTxType, setAmountStr, setTxCurrency, setDescription, setDate, setSelectedCatId, setSelectedBank, inputCurrency);
      return;
    }
    if (!transactionId) return;
    getDoc(doc(db, 'transactions', transactionId))
      .then(snap => {
        if (snap.exists()) {
          setExistingTx({ id: snap.id, ...snap.data() } as Transaction);
          applyTxData(snap.data() as Parameters<typeof applyTxData>[0], setTxType, setAmountStr, setTxCurrency, setDescription, setDate, setSelectedCatId, setSelectedBank, inputCurrency);
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

    setSaving(true);
    setErrorMsg(null);
    const preset = PRESET_CATS.find(p => p.id === selectedCatId);
    const id = transactionId ?? makeId();

    if (isNew) {
      try {
        const data: Record<string, unknown> = {
          id,
          type:        txType,
          amount,
          currency:    txCurrency,
          description: description.trim(),
          date:        dateInputToIso(date),
          categoryId:  preset?.id ?? '',
          category:    preset ? catDisplayName(preset) : '',
        };
        if (selectedBank) data.bank = selectedBank;
        const token = await user.getIdToken();
        const resp = await fetch('/api/ai/entityCreate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ userId: user.uid, entityType: 'transaction', docId: id, data }),
        });
        if (resp.status === 429) {
          const body = await resp.json().catch(() => ({}));
          setUsedTx(body.current ?? limit);
          setShowPaywall(true);
          setSaving(false);
          return;
        }
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          console.error('FinanceEditor create error', resp.status);
          setErrorMsg(body?.code === 'fx_unavailable' ? t.fxUnavailable : t.saveFailed);
          setSaving(false);
          return;
        }
        if (selectedBank) {
          try { localStorage.setItem(LAST_BANK_KEY, selectedBank); } catch { /* ignore */ }
        }
        onBack();
      } catch (err) {
        console.error('FinanceEditor create error', err);
        setSaving(false);
      }
      return;
    }

    // Update existing transaction — through the server, which owns the money
    // fields. Metadata-only edits keep rubAmount/fx; an amount edit reprices
    // with the ORIGINAL rate. The client never sends rubAmount or fx.
    try {
      const patch: Record<string, unknown> = {
        type:        txType,
        amount,
        description: description.trim(),
        categoryId:  preset?.id ?? '',
        category:    preset ? catDisplayName(preset) : '',
      };
      // Same day → keep the stored timestamp untouched; new day → that day at
      // the original time of day (or now if the record had none).
      const originalIso = existingTx?.date;
      if (!originalIso || isoToDateInput(originalIso) !== date) {
        const base = originalIso ? new Date(originalIso) : new Date();
        patch.date = dateInputToIso(date, base);
      }
      if (selectedBank) patch.bank = selectedBank;
      const token = await user.getIdToken();
      const resp = await fetch('/api/ai/transactionUpdate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ id, patch }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        console.error('FinanceEditor save error', resp.status);
        setErrorMsg(body?.code === 'fx_unavailable' ? t.fxUnavailable : t.saveFailed);
        setSaving(false);
        return;
      }
      if (selectedBank) {
        try { localStorage.setItem(LAST_BANK_KEY, selectedBank); } catch { /* ignore */ }
      }
      onBack();
    } catch (err) {
      console.error('FinanceEditor save error', err);
      setErrorMsg(t.saveFailed);
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

      {showPaywall && (
        <Paywall
          featureName={language === 'ru' ? `транзакции (лимит ${limit}/мес)` : `transactions (limit ${limit}/mo)`}
          language={language}
          onClose={() => setShowPaywall(false)}
          onUpgrade={() => { setShowPaywall(false); onBack(); }}
        />
      )}

      {isNew && isFree && near80 && !showPaywall && (
        <LimitBanner
          message={language === 'ru'
            ? `Транзакции: ${usedTx}/${limit} в этом месяце`
            : `Transactions: ${usedTx}/${limit} this month`}
          onUpgrade={() => setShowPaywall(true)}
          upgradeLabel={language === 'ru' ? 'Убрать лимит' : 'Remove limit'}
        />
      )}

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

      {/* ── Details of a locked foreign-currency transaction ── */}
      {existingTx && hasLockedRub(existingTx) && existingTx.currency && existingTx.currency !== 'RUB' && existingTx.fx && (
        <div className="fin-editor__fx-details">
          <div><span>{t.detailsAmount}</span><b>{formatCurrency(existingTx.amount, existingTx.currency, language)}</b></div>
          <div><span>{t.detailsInBudget}</span><b>≈ {formatCurrency(existingTx.rubAmount as number, 'RUB', language)}</b></div>
          <div><span>{t.detailsRate}</span><b>1 {getCurrencySymbol(existingTx.currency)} = {existingTx.fx.rateToRub.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 4 })} ₽</b></div>
          <div><span>{t.detailsSource}</span><b>{isEstimatedRate(existingTx) ? t.sourceEstimate : t.sourceBank}</b></div>
          {existingTx.fx.capturedAt && (
            <div><span>{t.detailsCaptured}</span><b>{new Date(existingTx.fx.capturedAt).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US')}</b></div>
          )}
        </div>
      )}

      {errorMsg && <div className="fin-editor__error" role="alert">{errorMsg}</div>}

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

      {/* ── Bank / Payment method ── */}
      {banks.length > 0 && (
        <>
          <div className="fin-editor__section-label">{t.bankLabel}</div>
          <div className="fin-editor__bank-chips">
            {banks.map(bank => (
              <button
                key={bank}
                className={`fin-editor__bank-chip${selectedBank === bank ? ' fin-editor__bank-chip--active' : ''}`}
                onClick={() => setSelectedBank(selectedBank === bank ? '' : bank)}
                type="button"
              >
                {bank}
              </button>
            ))}
          </div>
        </>
      )}

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
