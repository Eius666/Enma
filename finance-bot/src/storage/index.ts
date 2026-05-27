import { getConfig } from '../utils/config';
import { logError } from '../utils/logger';
import { postTransactionToApi } from './apiClient';
import { insertTransaction } from './sqliteRepo';
import { TransactionToSave } from './types';

export async function saveTransaction(transaction: TransactionToSave): Promise<'api' | 'sqlite'> {
  const config = getConfig();

  if (config.storageMode === 'api') {
    try {
      await postTransactionToApi(transaction, {
        baseUrl: config.apiBaseUrl,
        token: config.apiToken
      });
      return 'api';
    } catch (error) {
      logError('API storage failed, falling back to SQLite', error);
      await insertTransaction(transaction);
      return 'sqlite';
    }
  }

  await insertTransaction(transaction);
  return 'sqlite';
}
