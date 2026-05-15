import React, { useEffect, useMemo, useState } from 'react';
import './styles/finance.css';
import { parseISO } from 'date-fns';
import { FaPlus, FaTag, FaTimes, FaTrash } from 'react-icons/fa';
import { createT } from '../../i18n/createT';
import { formatDate } from '../../utils/formatDate';
import { getNumberLocale } from '../../utils/formatCurrency';
import { createId } from './types';
import type { Language, Currency, Category, Transaction } from './types';

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
  onRefreshTransactions: () => void;
};

export const FinanceWorkspace: React.FC<FinanceWorkspaceProps> = ({
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
  onRefreshTransactions,
}) => {
  const t = createT(language);
  const [draft, setDraft] = useState({
    type: 'income' as 'income' | 'expense',
    amount: '',
    description: '',
    categoryId: '' as string,
  });
  const [categoryDraft, setCategoryDraft] = useState<{ name: string; type: 'income' | 'expense' }>({
    name: '',
    type: 'expense',
  });

  useEffect(() => {
    if (!draft.categoryId) {
      const defaultCategory = categories.find(category => category.type === draft.type);
      if (defaultCategory) {
        setDraft(prev => ({ ...prev, categoryId: defaultCategory.id }));
      }
    }
  }, [draft.type, draft.categoryId, categories]);

  const relevantCategories = categories.filter(category => category.type === draft.type);

  const totals = useMemo(() => {
    const income = transactions
      .filter(tx => tx.type === 'income')
      .reduce((sum, tx) => sum + tx.amount, 0);
    const expenses = transactions
      .filter(tx => tx.type === 'expense')
      .reduce((sum, tx) => sum + tx.amount, 0);
    return { income, expenses, balance: income - expenses };
  }, [transactions]);

  const fmt = (amount: number) =>
    convertAmount(amount).toLocaleString(getNumberLocale(language), {
      style: 'currency',
      currency,
    });

  const addTransaction = () => {
    const amount = parseFloat(draft.amount);
    if (!draft.description.trim()) {
      alert(t('finance.errorNoDescription'));
      return;
    }
    if (!amount || amount <= 0) {
      alert(t('finance.errorInvalidAmount'));
      return;
    }
    if (!draft.categoryId) {
      alert(t('finance.errorNoCategory'));
      return;
    }
    const transaction: Transaction = {
      id: createId(),
      type: draft.type,
      amount: convertToBase(amount),
      categoryId: draft.categoryId,
      description: draft.description.trim(),
      date: new Date().toISOString(),
    };
    onTransactionsChange([transaction, ...transactions]);
    onPersistTransaction(transaction);
    alert(t('finance.successAdded', { type: draft.type === 'income' ? t('finance.transactionTypeIncome') : t('finance.transactionTypeExpense'), amount }));
    setDraft({ ...draft, amount: '', description: '' });
  };

  const addCategory = () => {
    if (!categoryDraft.name.trim()) return;
    const newCategory: Category = {
      id: createId(),
      name: categoryDraft.name.trim(),
      type: categoryDraft.type,
    };
    onCategoriesChange([...categories, newCategory]);
    setCategoryDraft({ name: '', type: 'expense' });
  };

  const deleteCategory = (categoryId: string) => {
    onCategoriesChange(categories.filter(category => category.id !== categoryId));
    setDraft(prev => (prev.categoryId === categoryId ? { ...prev, categoryId: '' } : prev));
  };

  const deleteTransaction = (id: string) => {
    onTransactionsChange(transactions.filter(tx => tx.id !== id));
    onDeleteTransaction(id);
  };

  const resolveCategory = (categoryId: string) =>
    categories.find(category => category.id === categoryId)?.name ?? t('finance.uncategorized');

  return (
    <section className="panel finance-panel">
      <div className="finance-upper">
        <div className="finance-summary-grid">
          <div className="summary-card">
            <span className="tile-label">{t('finance.balance')}</span>
            <span className="tile-value">{fmt(totals.balance)}</span>
          </div>
          <div className="summary-card positive">
            <span className="tile-label">{t('finance.income')}</span>
            <span className="tile-value">{fmt(totals.income)}</span>
          </div>
          <div className="summary-card negative">
            <span className="tile-label">{t('finance.expenses')}</span>
            <span className="tile-value">{fmt(totals.expenses)}</span>
          </div>
        </div>
        <div className="transaction-form-card">
          <h3>{t('finance.logTransactionTitle')}</h3>
          <div className="type-toggle">
            {(['income', 'expense'] as const).map(type => (
              <button
                key={type}
                className={`type-pill ${draft.type === type ? 'is-active' : ''}`}
                onClick={() => setDraft(prev => ({ ...prev, type, categoryId: '' }))}
              >
                {type === 'income' ? t('finance.transactionTypeIncome') : t('finance.transactionTypeExpense')}
              </button>
            ))}
          </div>
          <label className="floating-label">
            <span>{t('finance.amountLabel')}</span>
            <input
              type="number"
              value={draft.amount}
              onChange={event => setDraft(prev => ({ ...prev, amount: event.target.value }))}
              placeholder="0.00"
            />
          </label>
          <label className="floating-label">
            <span>{t('finance.descriptionLabel')}</span>
            <input
              value={draft.description}
              onChange={event =>
                setDraft(prev => ({ ...prev, description: event.target.value }))
              }
              placeholder={t('finance.descriptionPlaceholder')}
            />
          </label>
          <label className="floating-label">
            <span>{t('finance.categoryLabel')}</span>
            <select
              value={draft.categoryId}
              onChange={event =>
                setDraft(prev => ({ ...prev, categoryId: event.target.value }))
              }
            >
              <option value="" disabled>
                {t('finance.chooseCategory')}
              </option>
              {relevantCategories.map(category => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button add-transaction" onClick={addTransaction}>
            <FaPlus /> {t('finance.saveTransaction')}
          </button>
        </div>
      </div>

      <div className="finance-lower">
        <div className="category-card">
          <header>
            <span className="card-badge muted">{t('finance.categoriesBadge')}</span>
            <h3>{t('finance.categoriesTitle')}</h3>
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
                  aria-label={t('finance.deleteCategoryAria', { name: category.name })}
                >
                  <FaTimes />
                </button>
              </div>
            ))}
          </div>
          <div className="category-form">
            <label className="floating-label">
              <span>{t('finance.categoryNameLabel')}</span>
              <input
                value={categoryDraft.name}
                onChange={event =>
                  setCategoryDraft(prev => ({ ...prev, name: event.target.value }))
                }
                placeholder={t('finance.categoryNamePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('finance.categoryTypeLabel')}</span>
              <select
                value={categoryDraft.type}
                onChange={event =>
                  setCategoryDraft(prev => ({
                    ...prev,
                    type: event.target.value as 'income' | 'expense',
                  }))
                }
              >
                <option value="income">{t('finance.categoryTypeIncome')}</option>
                <option value="expense">{t('finance.categoryTypeExpense')}</option>
              </select>
            </label>
            <button className="ghost-button" onClick={addCategory}>
              <FaPlus /> {t('finance.addCategory')}
            </button>
          </div>
        </div>

        <div className="transactions-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>{t('finance.recentActivity')} ({transactions.length})</h3>
            <button
              className="ghost-button"
              onClick={onRefreshTransactions}
              style={{ padding: '8px 16px' }}
            >
              🔄 {t('finance.refresh')}
            </button>
          </div>
          {transactions.length === 0 ? (
            <p className="empty-hint">{t('finance.noTransactions')}</p>
          ) : (
            <ul className="transactions-list">
              {transactions.map(tx => (
                <li key={tx.id} className={`transaction-row ${tx.type}`}>
                  <div className="transaction-main">
                    <span className="category-tag">{resolveCategory(tx.categoryId)}</span>
                    <p className="transaction-description">{tx.description}</p>
                    <span className="transaction-date">
                      {formatDate(language, parseISO(tx.date), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  <div className="transaction-meta">
                    <span className="transaction-amount">
                      {tx.type === 'income' ? '+' : ''}
                      {fmt(tx.amount)}
                    </span>
                    <button
                      className="icon-button"
                      onClick={() => deleteTransaction(tx.id)}
                      aria-label={t('finance.deleteTransactionAria')}
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
