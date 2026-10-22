// Startup timing marks for local and DEV diagnosis (BUG-02, slow first launch).
//
// Recorded only in a development build (`npm start`) or a build made with
// REACT_APP_PERF_MARKS=true — in any other build every function here does
// nothing. Imported only from the app chunk, never from src/index.tsx, so the
// startup bundle (main.js) stays as it was. Marks hold a phase name and a
// time in ms since navigation start (performance.now());
// never ids, names, payloads or anything about the user. Nothing is sent
// anywhere: the summary is printed to this device's console and kept in
// window.__enmaPerf for manual inspection.

export type PerfPhase =
  | 'app-chunk-loaded'
  | 'telegram-sdk-ready'
  | 'auth-resolved'
  | 'telegram-auth-start'
  | 'telegram-auth-done'
  | 'telegram-auth-failed'
  | 'shell-rendered'
  | 'first-snapshot:transactions'
  | 'first-snapshot:habits'
  | 'first-snapshot:tasks'
  | 'first-snapshot:reminders'
  | 'first-snapshot:subscription'
  | 'first-snapshot:user-doc'
  | 'first-snapshot:notes';

export interface PerfEntry { phase: PerfPhase; ms: number }

const SUMMARY_AFTER: PerfPhase[] = [
  'shell-rendered',
  'first-snapshot:transactions', 'first-snapshot:habits', 'first-snapshot:tasks', 'first-snapshot:subscription',
];

export function isPerfMarksEnabled(env: { NODE_ENV?: string; REACT_APP_PERF_MARKS?: string }): boolean {
  return env.NODE_ENV === 'development' || env.REACT_APP_PERF_MARKS === 'true';
}

// Written out (not via isPerfMarksEnabled) so the build substitutes the values.
// When REACT_APP_PERF_MARKS is not set at build time the check is made at
// start-up instead (and is false): the recording code stays in the bundle but
// never runs.
const enabled = process.env.NODE_ENV === 'development' || process.env.REACT_APP_PERF_MARKS === 'true';
const entries: PerfEntry[] = [];
let summaryPrinted = false;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? Math.round(performance.now()) : 0;

/** Records the first occurrence of a phase. No-op unless enabled. */
export function perfMark(phase: PerfPhase): void {
  if (!enabled) return;
  if (entries.some(e => e.phase === phase)) return;
  const ms = now();
  entries.push({ phase, ms });
  try { performance.mark?.(`enma:${phase}`); } catch { /* unsupported — the entry above is enough */ }
  if (typeof window !== 'undefined') {
    (window as unknown as { __enmaPerf?: PerfEntry[] }).__enmaPerf = entries.slice();
  }
  if (!summaryPrinted && SUMMARY_AFTER.every(p => entries.some(e => e.phase === p))) {
    summaryPrinted = true;
    console.info('[perf] startup', formatPerfSummary(entries));
  }
}

/** "app-chunk-loaded 180ms → auth-resolved 420ms → …" in recording order. */
export function formatPerfSummary(list: PerfEntry[]): string {
  return list.map(e => `${e.phase} ${e.ms}ms`).join(' → ');
}

/** Copy of what was recorded so far (empty when disabled). */
export function getPerfEntries(): PerfEntry[] {
  return entries.slice();
}
