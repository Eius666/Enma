import { parseTransactionInput } from '../src/bot/parser';

const now = new Date(2026, 1, 15, 12, 0, 0);

describe('parseTransactionInput', () => {
  test('parses expense with amount', () => {
    const result = parseTransactionInput('расход 450', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('expense');
      expect(result.transaction.amount).toBe(450);
      expect(result.transaction.currency).toBe('RUB');
      expect(result.transaction.description).toBeUndefined();
      expect(result.transaction.date).toBe('2026-02-15');
    }
  });

  test('parses income with description', () => {
    const result = parseTransactionInput('доход 120000 зарплата', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('income');
      expect(result.transaction.amount).toBe(120000);
      expect(result.transaction.description).toBe('зарплата');
    }
  });

  test('parses decimal amount with dot', () => {
    const result = parseTransactionInput('расход 999.50 кофе', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.amount).toBeCloseTo(999.5);
      expect(result.transaction.description).toBe('кофе');
    }
  });

  test('parses english income', () => {
    const result = parseTransactionInput('income 20 lunch', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('income');
      expect(result.transaction.amount).toBe(20);
      expect(result.transaction.description).toBe('lunch');
    }
  });

  test('parses yesterday date', () => {
    const result = parseTransactionInput('expense 1500 такси вчера', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('expense');
      expect(result.transaction.date).toBe('2026-02-14');
      expect(result.transaction.description).toBe('такси');
    }
  });

  test('parses plus sign as income', () => {
    const result = parseTransactionInput('+ 5000 премия', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('income');
      expect(result.transaction.amount).toBe(5000);
      expect(result.transaction.description).toBe('премия');
    }
  });

  test('parses minus sign as expense', () => {
    const result = parseTransactionInput('- 300 продукты', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.type).toBe('expense');
      expect(result.transaction.amount).toBe(300);
      expect(result.transaction.description).toBe('продукты');
    }
  });

  test('parses ISO date format', () => {
    const result = parseTransactionInput('расход 1000 2026-02-01', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.date).toBe('2026-02-01');
    }
  });

  test('parses DD.MM.YYYY format', () => {
    const result = parseTransactionInput('доход 1000 01.03.2026', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.date).toBe('2026-03-01');
    }
  });

  test('detects USD currency', () => {
    const result = parseTransactionInput('expense 20 $ lunch', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.currency).toBe('USD');
      expect(result.transaction.description).toBe('lunch');
    }
  });

  test('detects EUR currency', () => {
    const result = parseTransactionInput('income 30 eur dinner', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.currency).toBe('EUR');
      expect(result.transaction.description).toBe('dinner');
    }
  });

  test('detects RUB currency symbol', () => {
    const result = parseTransactionInput('расход 200 ₽ кофе', now);
    expect('transaction' in result).toBe(true);
    if ('transaction' in result) {
      expect(result.transaction.currency).toBe('RUB');
      expect(result.transaction.description).toBe('кофе');
    }
  });

  test('returns missing amount error', () => {
    const result = parseTransactionInput('доход', now);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('missing_amount');
    }
  });

  test('returns missing type error', () => {
    const result = parseTransactionInput('1000 продукты', now);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('missing_type');
    }
  });
});
