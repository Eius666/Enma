import { ParsedTransaction } from './parser';

export interface SessionState {
  pending?: ParsedTransaction;
}

const sessions = new Map<string, SessionState>();

export function getSession(userId: string): SessionState {
  const existing = sessions.get(userId);
  if (existing) {
    return existing;
  }
  const state: SessionState = {};
  sessions.set(userId, state);
  return state;
}

export function setPending(userId: string, transaction: ParsedTransaction): void {
  const session = getSession(userId);
  session.pending = transaction;
}

export function clearPending(userId: string): void {
  const session = getSession(userId);
  delete session.pending;
}
