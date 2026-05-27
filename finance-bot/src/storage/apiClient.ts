import { TransactionToSave } from './types';

export interface ApiConfig {
  baseUrl: string;
  token?: string;
}

export async function postTransactionToApi(transaction: TransactionToSave, config: ApiConfig): Promise<void> {
  if (!config.baseUrl) {
    throw new Error('API base URL is not configured');
  }

  const url = `${config.baseUrl.replace(/\/$/, '')}/transactions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(transaction)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
}
