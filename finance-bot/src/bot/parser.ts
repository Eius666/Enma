import { detectCurrency, stripCurrencyTokens, Currency } from '../utils/currency';
import { findDateInText, formatDate } from '../utils/date';

export type TransactionType = 'income' | 'expense';

export interface ParsedTransaction {
  type: TransactionType;
  amount: number;
  currency: Currency;
  description?: string;
  date: string;
}

export type ParseErrorCode = 'missing_type' | 'missing_amount' | 'invalid_amount';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
}

export type ParseResult =
  | { transaction: ParsedTransaction }
  | { error: ParseError };

const incomeRegex = /(^|\s)(доход|income)(?=\s|$|[.,!?])/i;
const expenseRegex = /(^|\s)(расход|expense)(?=\s|$|[.,!?])/i;
const amountRegex = /([+-]?\d+(?:[.,]\d+)?)/;

function detectType(text: string, amountMatch: RegExpMatchArray | null): TransactionType | null {
  const lower = text.toLowerCase();
  const hasIncome = incomeRegex.test(lower);
  const hasExpense = expenseRegex.test(lower);
  if (hasIncome && hasExpense) {
    return null;
  }
  if (hasIncome) {
    return 'income';
  }
  if (hasExpense) {
    return 'expense';
  }

  const signMatch = text.match(/(^|\s)([+-])\s*\d/);
  if (signMatch) {
    return signMatch[2] === '+' ? 'income' : 'expense';
  }

  if (amountMatch && amountMatch[1].startsWith('-')) {
    return 'expense';
  }
  if (amountMatch && amountMatch[1].startsWith('+')) {
    return 'income';
  }

  return null;
}

function parseAmount(raw: string): number {
  const normalized = raw.replace(',', '.').replace(/[+-]/g, '');
  return Number.parseFloat(normalized);
}

function cleanDescription(text: string): string {
  const trimmed = text.replace(/^[,.:;-]+/, '').replace(/\s+/g, ' ').trim();
  return trimmed;
}

export function parseTransactionInput(text: string, now: Date = new Date()): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: { code: 'missing_amount', message: 'Empty input' } };
  }

  const dateMatch = findDateInText(trimmed, now);
  const date = dateMatch ? dateMatch.date : formatDate(now);
  const textWithoutDate = dateMatch
    ? trimmed.replace(new RegExp(dateMatch.matchedText, 'i'), ' '.repeat(dateMatch.matchedText.length))
    : trimmed;

  const amountMatch = textWithoutDate.match(amountRegex);
  if (!amountMatch) {
    return { error: { code: 'missing_amount', message: 'Amount not found' } };
  }

  const amountValue = parseAmount(amountMatch[1]);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return { error: { code: 'invalid_amount', message: 'Amount must be positive' } };
  }

  const type = detectType(trimmed, amountMatch);
  if (!type) {
    return { error: { code: 'missing_type', message: 'Transaction type not found' } };
  }

  const currency = detectCurrency(trimmed);

  const amountIndex = amountMatch.index ?? -1;
  let description = amountIndex >= 0
    ? trimmed.slice(amountIndex + amountMatch[0].length)
    : '';

  if (dateMatch) {
    const dateRegex = new RegExp(dateMatch.matchedText, 'i');
    description = description.replace(dateRegex, ' ');
  }

  description = stripCurrencyTokens(description);
  description = cleanDescription(description);

  return {
    transaction: {
      type,
      amount: amountValue,
      currency,
      description: description ? description : undefined,
      date
    }
  };
}
