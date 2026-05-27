import { parseTransactionInput, ParsedTransaction } from './parser';
import { clearPending, getSession, setPending } from './session';
import { saveTransaction } from '../storage';
import { formatCurrency } from '../utils/currency';
import { logError } from '../utils/logger';

export interface MessageResponse {
  reply: string;
  pendingTransaction?: ParsedTransaction;
}

function formatTypeLabel(type: 'income' | 'expense'): string {
  return type === 'income' ? 'Доход' : 'Расход';
}

function isYes(text: string): boolean {
  return ['да', 'yes', 'y'].includes(text.trim().toLowerCase());
}

function isNo(text: string): boolean {
  return ['нет', 'no', 'n'].includes(text.trim().toLowerCase());
}

function buildConfirmMessage(transaction: ParsedTransaction): string {
  const parts = [
    `Добавить: ${formatTypeLabel(transaction.type)} ${formatCurrency(transaction.amount, transaction.currency)}`
  ];
  if (transaction.description) {
    parts.push(`описание: ${transaction.description}`);
  }
  parts.push(`дата: ${transaction.date}`);
  return `${parts.join(', ')}. Подтвердить? (да/нет)`;
}

async function persistTransaction(transaction: ParsedTransaction): Promise<void> {
  await saveTransaction({
    ...transaction,
    source: 'chat'
  });
}

export async function handleMessage(userId: string, text: string, autoConfirm: boolean): Promise<MessageResponse> {
  const session = getSession(userId);

  if (session.pending) {
    if (isYes(text)) {
      const pending = session.pending;
      clearPending(userId);
      try {
        await persistTransaction(pending);
        return { reply: 'Добавлено ✅' };
      } catch (error) {
        logError('Failed to save confirmed transaction', error);
        return { reply: 'Не удалось сохранить транзакцию. Попробуйте позже.' };
      }
    }

    if (isNo(text)) {
      clearPending(userId);
      return { reply: 'Ок, отменено.' };
    }

    return { reply: 'Пожалуйста, ответьте "да" или "нет".' };
  }

  const result = parseTransactionInput(text);
  if ('error' in result) {
    if (result.error.code === 'missing_type') {
      return { reply: 'Не понял тип. Это доход или расход?' };
    }
    if (result.error.code === 'missing_amount') {
      return { reply: 'Не нашел сумму. Напишите, например: "расход 450 кофе".' };
    }
    return { reply: 'Сумма должна быть больше 0.' };
  }

  if (autoConfirm) {
    try {
      await persistTransaction(result.transaction);
      return { reply: 'Добавлено ✅' };
    } catch (error) {
      logError('Failed to save transaction', error);
      return { reply: 'Не удалось сохранить транзакцию. Попробуйте позже.' };
    }
  }

  setPending(userId, result.transaction);
  return {
    reply: buildConfirmMessage(result.transaction),
    pendingTransaction: result.transaction
  };
}
