import fs from 'fs';
import path from 'path';

const logFilePath = path.resolve(process.cwd(), 'logs', 'app.log');

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function writeLine(line: string): void {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  fs.appendFileSync(logFilePath, line, { encoding: 'utf-8' });
}

export function logInfo(message: string): void {
  const line = `[${new Date().toISOString()}] INFO ${message}\n`;
  writeLine(line);
}

export function logError(message: string, error?: unknown): void {
  const detail = error ? ` | ${formatError(error)}` : '';
  const line = `[${new Date().toISOString()}] ERROR ${message}${detail}\n`;
  writeLine(line);
}
