import React, { useEffect, useMemo, useState } from 'react';
import { parseISO } from 'date-fns';
import { FaPlus, FaTag, FaTimes, FaTrash } from 'react-icons/fa';
import { translate, getNumberLocale } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { createId, formatDate } from '../lib/utils';
import type { Category, Currency, Language, Transaction } from '../types';

type FinanceWorkspaceProps = {
  language: Language;
  currency: Currency;
  convertAmount: (amount: number) => number;
  convertToBase: (amount: number) => number;
  categories: Category[];
  onCategoriesChange: (categories: Category[]) => void;
  transactions: Transaction[];
  onTransactionsChange: (transactions: Transaction[]) => void;
  onPersistTransaction: (transaction: Transaction) => void;
  onDeleteTransaction: (id: string) => void;
  notify: (message: string) => void;
};

const FinanceWorkspace: React.FC<FinanceWorkspaceProps> = ({
  language,
  currency,
  convertAmount,
  convertToBase,
  categories,
  onCategoriesChange,
  transactions,
  onTransactionsChange,
  onPersistTransaction,
  onDeleteTransaction,
  notify
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const [draft, setDraft] = useState({
    type: 'income' as 'income' | 'expense',
    amount: '',
    description: '',
    categoryId: ''
  });
  const [categoryDraft, setCategoryDraft] = useState<{ name: string; type: 'income' | 'expense' }>({
    name: '',
    type: 'expense'
  });

  useEffect(() => {
    if (!draft.categoryId) {
      const defaultCategory = categories.find(c => c.type === draft.type);
      if (defaultCategory) setDraft(prev => ({ ...prev, categoryId: defaultCategory.id }));
    }
  }, [draft.type, draft.categoryId, categories]);

  const relevantCategories = categories.filter(c => c.type === draft.type);

  const totals = useMemo(() => {
    const income = transactions.filter(tx => tx.type === 'income').reduce((s, tx) => s + tx.amount, 0);
    const expenses = transactions.filter(tx => tx.type === 'expense').reduce((s, tx) => s + tx.amount, 0);
    return { income, expenses, balance: income - expenses };
  }, [transactions]);

  const formatCurrency = (amount: number) =>
    convertAmount(amount).toLocaleString(getNumberLocale(language), { style: 'currency', currency });

  const resolveCategory = (categoryId: string) =>
    categories.find(c => c.id === categoryId)?.name ?? t('uncategorized');

  const addTransaction = () => {
    const amount = parseFloat(draft.amount);
    if (!draft.description.trim()) { notify(t('transactionDescriptionRequired')); return; }
    if (!amount || amount <= 0) { notify(t('transactionAmountInvalid')); return; }
    if (!draft.categoryId) { notify(t('transactionCategoryRequired')); return; }
    const baseAmount = convertToBase(amount);
    const transaction: Transaction = {
      id: createId(),
      type: draft.type,
      amount: baseAmount,
      categoryId: draft.categoryId,
      description: draft.description.trim(),
      date: new Date().toISOString()
    };
    onTransactionsChange([transaction, ...transactions]);
    onPersistTransaction(transaction);
    const typeLabel = draft.type === 'income' ? t('transactionTypeIncome') : t('transactionTypeExpense');
    notify(t('transactionAdded', { type: typeLabel, amount: formatCurrency(baseAmount) }));
    setDraft(prev => ({ ...prev, amount: '', description: '' }));
  };

  const addCategory = () => {
    if (!categoryDraft.name.trim()) return;
    const newCategory: Category = { id: createId(), name: categoryDraft.name.trim(), type: categoryDraft.type };
    onCategoriesChange([...categories, newCategory]);
    setCategoryDraft({ name: '', type: 'expense' });
  };

  const deleteCategory = (categoryId: string) => {
    onCategoriesChange(categories.filter(c => c.id !== categoryId));
    setDraft(prev => (prev.categoryId === categoryId ? { ...prev, categoryId: '' } : prev));
  };

  const deleteTransaction = (id: string) => {
    onTransactionsChange(transactions.filter(tx => tx.id !== id));
    onDeleteTransaction(id);
  };

  return (
    <section className="panel finance-panel">
      <div className="finance-upper">
        <div className="finance-summary-grid">
          <div className="summary-card">
            <span className="tile-label">{t('financeBalance')}</span>
            <span className="tile-value">{formatCurrency(totals.balance)}</span>
          </div>
          <div className="summary-card positive">
            <span className="tile-label">{t('financeIncome')}</span>
            <span className="tile-value">{formatCurrency(totals.income)}</span>
          </div>
          <div className="summary-card negative">
            <span className="tile-label">{t('financeExpenses')}</span>
            <span className="tile-value">-{formatCurrency(totals.expenses)}</span>
          </div>
        </div>
        <div className="category-card">
          <header>
            <span className="card-badge muted">{t('categoriesBadge')}</span>
            <h3>{t('categoriesTitle')}</h3>
          </header>
          <div className="category-quick-list">
            {categories.map(category => (
              <div key={category.id} className="category-chip">
                <FaTag />
                <span>{category.name}</span>
                <button
                  type="button"
                  className="category-remove"
                  onClick={() => deleteCategory(category.id)}
                  aria-label={t('deleteCategoryAria', { name: category.name })}
                >
                  <FaTimes />
                </button>
              </div>
            ))}
          </div>
          <div className="category-form">
            <label className="floating-label">
              <span>{t('categoryNameLabel')}</span>
              <input
                value={categoryDraft.name}
                onChange={e => setCategoryDraft(prev => ({ ...prev, name: e.target.value }))}
                placeholder={t('categoryNamePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('categoryTypeLabel')}</span>
              <select
                value={categoryDraft.type}
                onChange={e =>
                  setCategoryDraft(prev => ({ ...prev, type: e.target.value as 'income' | 'expense' }))
                }
              >
                <option value="income">{t('categoryTypeIncome')}</option>
                <option value="expense">{t('categoryTypeExpense')}</option>
              </select>
            </label>
            <button className="ghost-button" onClick={addCategory}>
              <FaPlus /> {t('addCategory')}
            </button>
          </div>
        </div>
      </div>

      <div className="finance-lower">
        <div className="transaction-form-card">
          <h3>{t('logTransactionTitle')}</h3>
          <div className="type-toggle">
            {(['income', 'expense'] as const).map(type => (
              <button
                key={type}
                className={`type-pill ${draft.type === type ? 'is-active' : ''}`}
                onClick={() => setDraft(prev => ({ ...prev, type, categoryId: '' }))}
              >
                {type === 'income' ? t('transactionTypeIncome') : t('transactionTypeExpense')}
              </button>
            ))}
          </div>
          <label className="floating-label">
            <span>{t('amountLabel')}</span>
            <input
              type="number"
              value={draft.amount}
              onChange={e => setDraft(prev => ({ ...prev, amount: e.target.value }))}
              placeholder="0.00"
            />
          </label>
          <label className="floating-label">
            <span>{t('descriptionLabel')}</span>
            <input
              value={draft.description}
              onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
              placeholder={t('descriptionPlaceholder')}
            />
          </label>
          <label className="floating-label">
            <span>{t('categoryLabel')}</span>
            <select
              value={draft.categoryId}
              onChange={e => setDraft(prev => ({ ...prev, categoryId: e.target.value }))}
            >
              <option value="" disabled>{t('chooseCategory')}</option>
              {relevantCategories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <button className="primary-button add-transaction" onClick={addTransaction}>
            <FaPlus /> {t('saveTransaction')}
          </button>
        </div>

        <div className="transactions-card">
          <h3>{t('recentActivity')} ({transactions.length})</h3>
          {transactions.length === 0 ? (
            <p className="empty-hint">{t('noTransactions')}</p>
          ) : (
            <ul className="transactions-list">
              {transactions.map(tx => (
                <li key={tx.id} className={`transaction-row ${tx.type}`}>
                  <div className="transaction-main">
                    <span className="category-tag">{resolveCategory(tx.categoryId)}</span>
                    <p className="transaction-description">{tx.description}</p>
                    <span className="transaction-date">
                      {formatDate(language, parseISO(tx.date), 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <div className="transaction-meta">
                    <span className="transaction-amount">
                      {tx.type === 'income' ? '+' : '-'}{formatCurrency(tx.amount)}
                    </span>
                    <button
                      className="icon-button"
                      onClick={() => deleteTransaction(tx.id)}
                      aria-label={t('deleteTransactionAria')}
                    >
                      <FaTrash />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};

export default FinanceWorkspace;
