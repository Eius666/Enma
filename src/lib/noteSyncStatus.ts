// Error classification for the notes save path (ENMA notes-durability
// audit, PHASE 2/4). Kept as plain, dependency-free functions/classes so
// they're testable without React, Firestore, or a DOM.

// Deliberately NOT using a TS parameter-property constructor
// (`constructor(public x: number)`) — this repo's unit tests run .ts files
// directly via Node's native type-stripping (see src/lib/__tests__/
// authBootstrap.test.ts precedent), which only erases type annotations and
// does not perform the extra code-generation parameter properties need.
export class NoteConflictError extends Error {
  code: 'note/conflict';
  serverRev: number;

  constructor(serverRev: number) {
    super('This note was changed elsewhere since it was loaded.');
    this.code = 'note/conflict';
    this.serverRev = serverRev;
  }
}

export type WriteErrorKind = 'network' | 'conflict' | 'other';

// Firestore error codes that mean "couldn't reach/finish talking to the
// server" rather than "the server rejected this write" — surfaced to the
// user as "offline", not as a generic failure.
const NETWORK_CODES = new Set(['unavailable', 'deadline-exceeded', 'resource-exhausted']);

export function classifyWriteError(err: unknown): WriteErrorKind {
  if (err instanceof NoteConflictError) return 'conflict';
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'network';
  return 'other';
}
