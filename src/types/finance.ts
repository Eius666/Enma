export type Currency = 'RUB' | 'USD' | 'EUR' | 'BYN' | 'CNY';

export interface FinanceTransaction {
  id: string;
  workspaceId: string;
  userId: string;
  amount: number;
  currency: Currency;
  category: string;
  type: 'income' | 'expense';
  description?: string;
  date: number;
  createdAt: number;
}

export interface FinanceSummary {
  income: number;
  expense: number;
  balance: number;
  currency: Currency;
}
