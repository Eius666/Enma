import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  apiBaseUrl: string;
  apiToken?: string;
  storageMode: 'api' | 'sqlite';
  autoConfirm: boolean;
  port: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
}

export function getConfig(): AppConfig {
  return {
    apiBaseUrl: process.env.APP_API_BASE_URL || '',
    apiToken: process.env.APP_API_TOKEN,
    storageMode: (process.env.STORAGE_MODE || 'api') as 'api' | 'sqlite',
    autoConfirm: parseBoolean(process.env.AUTO_CONFIRM, false),
    port: process.env.PORT ? Number(process.env.PORT) : 3001
  };
}
