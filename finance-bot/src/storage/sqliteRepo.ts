import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { TransactionToSave } from './types';

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

async function getDb(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (db) {
    return db;
  }

  const dbPath = path.resolve(process.cwd(), 'data', 'transactions.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      source TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  return db;
}

export async function insertTransaction(transaction: TransactionToSave): Promise<void> {
  const database = await getDb();
  await database.run(
    `
    INSERT INTO transactions (type, amount, currency, description, date, source, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    transaction.type,
    transaction.amount,
    transaction.currency,
    transaction.description || null,
    transaction.date,
    transaction.source,
    new Date().toISOString()
  );
}
