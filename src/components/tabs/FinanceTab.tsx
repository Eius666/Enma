import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import FinanceList from '../FinanceList';
import FinanceEditor from '../FinanceEditor';
import { FinancePdfButton } from '../FinancePdfExport';
import type { Subscription } from '../../subscription';
import type { Category, Currency, Language, Transaction } from '../../types/app';

interface Props {
  language: Language;
  user: User;
  /** Display (budget) currency of the list. */
  currency: Currency;
  /** Currency a new transaction is entered in. */
  inputCurrency: Currency;
  rates: Record<string, number>;
  categories: Category[];
  transactions: Transaction[];
  banks: string[];
  subscription: Subscription | null;
  subscriptionLoaded: boolean;
}

// "Finance" tab: the transaction list and the editor. The list/editor state is
// local and resets when the tab is left.
export function FinanceTab({
  language, user, currency, inputCurrency, rates, categories, transactions, banks, subscription, subscriptionLoaded,
}: Props): React.ReactElement {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [activeTransactionId, setActiveTransactionId] = useState<string | null>(null);

  return (
    <>
      {view === 'list' && (
        <FinanceList
          language={language}
          currency={currency}
          rates={rates}
          categories={categories}
          transactions={transactions}
          user={user}
          reportButton={
            <FinancePdfButton language={language} user={user} subscription={subscription} subscriptionLoaded={subscriptionLoaded} />
          }
          onOpenEditor={(id) => {
            setActiveTransactionId(id);
            setView('editor');
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}
        />
      )}
      {view === 'editor' && (
        <FinanceEditor
          transactionId={activeTransactionId}
          initialTransaction={
            activeTransactionId
              ? transactions.find(tx => tx.id === activeTransactionId) ?? null
              : null
          }
          user={user}
          language={language}
          inputCurrency={inputCurrency}
          banks={banks}
          subscription={subscription}
          onBack={() => {
            setView('list');
            setActiveTransactionId(null);
          }}
        />
      )}
    </>
  );
}
