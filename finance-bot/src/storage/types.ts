import { ParsedTransaction } from '../bot/parser';

export interface TransactionToSave extends ParsedTransaction {
  source: 'chat';
}
