// Startup timing marks for local and DEV diagnosis (BUG-02 / BUG-08, slow
// first launch).
//
// Recorded in a development build (`npm start`), in a build made with
// REACT_APP_PERF_MARKS=true, or — on any build except production — when the
// "startup diagnostics" switch in Settings is on (stored on this device only),
// so the timings can be collected on a phone from the DEV deployment. In any
// other case every function here does nothing.
//
// Imported only from the app chunk, never from src/index.tsx, so the startup
// bundle (main.js) stays as it was. Marks hold a phase name and a time in ms
// since navigation start (performance.now()); never ids, names, payloads or
// anything about the user. Nothing is sent anywhere: the summary is printed to
// this device's console, kept in window.__enmaPerf and, with the switch on,
// saved in localStorage for the Settings screen to show.

export type PerfPhase =
  | 'app-chunk-loaded'
  | 'telegram-sdk-ready'
  | 'first-render'
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
  | 'first-snapshot:notes'
  | 'tabs-preloaded';

export interface PerfEntry { phase: PerfPhase; ms: number }

/** One network request of the startup, by a fixed label (never its URL). */
export interface StartupRequest {
  name: string; start: number; end: number; count: number; cached?: boolean;
  /** The server's own phase timings (Server-Timing, DEV only): names and ms. */
  serverTiming?: Array<{ name: string; dur: number }>;
}

/**
 * How the saved Firebase session fared at start: 'restored' — a user came
 * back; 'rejected' — Firebase checked a saved session with its servers and
 * reported no user (deleted or disabled account, revoked or invalid token);
 * 'none' — there was nothing to check. No ids, tokens or claims.
 */
export interface StartupAuth {
  session: 'restored' | 'rejected' | 'none';
  /** Firebase's storage type at that moment: LOCAL (IndexedDB or localStorage), SESSION or NONE. */
  persistence?: string;
  indexedDbPresent: boolean;
}

/** What a start leaves for the Settings screen: labels and milliseconds only. */
export interface StartupRun {
  recordedAt: string;
  navigationType: string | null;
  page: {
    htmlReceived?: number; bundleStarted?: number; domReady?: number;
    /** Before the HTML: name lookup, connection (with TLS) and the first byte of the response. */
    dns?: number; connect?: number; firstByte?: number;
    /** First paint with content, when the browser reports it. */
    firstContentfulPaint?: number;
    /** src/firebaseApp.ts ran: Firebase Auth starts restoring the session. */
    authInit?: number;
  };
  requests: StartupRequest[];
  marks: PerfEntry[];
  auth?: StartupAuth;
  /** Random per start, sent to the server so its log line can be matched (DEV). */
  traceId?: string;
}

const SUMMARY_AFTER: PerfPhase[] = [
  'shell-rendered',
  'first-snapshot:transactions', 'first-snapshot:habits', 'first-snapshot:tasks', 'first-snapshot:subscription',
];

const PRODUCTION_FIREBASE_PROJECT = 'enma-4ea29';
const SWITCH_KEY = 'enma.startupDiagnostics';
const LAST_RUN_KEY = 'enma.startupDiagnostics.lastRun';

export function isPerfMarksEnabled(env: { NODE_ENV?: string; REACT_APP_PERF_MARKS?: string }): boolean {
  return env.NODE_ENV === 'development' || env.REACT_APP_PERF_MARKS === 'true';
}

/** The Settings switch exists on every build except production. */
export const startupDiagnosticsAvailable = process.env.REACT_APP_FIREBASE_PROJECT_ID !== PRODUCTION_FIREBASE_PROJECT;

const storage = (): Storage | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

export function isStartupDiagnosticsOn(): boolean {
  if (!startupDiagnosticsAvailable) return false;
  try { return storage()?.getItem(SWITCH_KEY) === '1'; } catch { return false; }
}

/** Takes effect from the next start (the marks of this one are already decided). */
export function setStartupDiagnostics(on: boolean): void {
  if (!startupDiagnosticsAvailable) return;
  try {
    const s = storage();
    if (!s) return;
    if (on) s.setItem(SWITCH_KEY, '1');
    else { s.removeItem(SWITCH_KEY); s.removeItem(LAST_RUN_KEY); }
  } catch { /* storage unavailable — nothing to switch */ }
}

export function readLastStartupRun(): StartupRun | null {
  if (!startupDiagnosticsAvailable) return null;
  try {
    const raw = storage()?.getItem(LAST_RUN_KEY);
    return raw ? (JSON.parse(raw) as StartupRun) : null;
  } catch { return null; }
}

// Written out (not via isPerfMarksEnabled) so the build substitutes the values.
// When REACT_APP_PERF_MARKS is not set at build time the check is made at
// start-up instead (and is false): the recording code stays in the bundle but
// never runs unless the Settings switch is on.
const enabled = process.env.NODE_ENV === 'development' || process.env.REACT_APP_PERF_MARKS === 'true' || isStartupDiagnosticsOn();
const persistRun = isStartupDiagnosticsOn();
const recordedAt = new Date().toISOString();
const entries: PerfEntry[] = [];
let authState: StartupAuth | undefined;
let traceId: string | null | undefined;

/**
 * A random id for this start (16 hex characters), only while diagnostics are
 * on; null otherwise. Sent as X-Enma-Trace so the DEV server log line of the
 * sign-in can be matched with this device's timings. Identifies nothing else.
 */
export function startupTraceId(): string | null {
  if (traceId !== undefined) return traceId;
  traceId = null;
  if (!enabled) return traceId;
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    traceId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  } catch { traceId = null; }
  return traceId;
}

/**
 * Called once, when Firebase first reports the session. Whether a saved
 * session was checked is read from the requests Firebase made before that
 * moment (a lookup or token refresh), not from storage.
 */
export function recordAuthState(userRestored: boolean, persistence?: string): void {
  if (!enabled || authState) return;
  let resources: ResourceLike[] = [];
  let at = 0;
  try {
    at = performance.now();
    resources = performance.getEntriesByType('resource') as unknown as ResourceLike[];
  } catch { /* no timing API */ }
  authState = {
    session: classifySession(userRestored, resources, at),
    persistence,
    indexedDbPresent: typeof indexedDB !== 'undefined',
  };
  if (persistRun) saveRun();
}

/** 'rejected' when Firebase checked a saved session (lookup or token refresh) before reporting no user. */
export function classifySession(userRestored: boolean, resources: ResourceLike[], at: number): StartupAuth['session'] {
  if (userRestored) return 'restored';
  const checked = resources.some(r => r.startTime <= at && /^auth: (accounts:lookup|token refresh)$/.test(requestLabel(r.name) ?? ''));
  return checked ? 'rejected' : 'none';
}
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
  if (persistRun) saveRun();
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

/**
 * A fixed label for a startup request, or null for anything else. Only the
 * host and the path shape are looked at; query strings (keys, session ids)
 * and anything user-specific never leave this function.
 */
export function requestLabel(url: string): string | null {
  let u: URL;
  try { u = new URL(url, 'https://app.invalid'); } catch { return null; }
  const path = u.pathname;
  if (u.hostname === 'telegram.org' && path.endsWith('/telegram-web-app.js')) return 'telegram-sdk';
  if (/^\/static\/js\/main\.[0-9a-f]+\.js$/.test(path)) return 'main.js';
  const chunk = /^\/static\/js\/(\d+)\.[0-9a-f]+\.chunk\.js$/.exec(path);
  if (chunk) return `chunk ${chunk[1]}`;
  if (/^\/static\/css\/.+\.css$/.test(path)) return 'css';
  if (u.hostname === 'securetoken.googleapis.com') return 'auth: token refresh';
  if (u.hostname === 'identitytoolkit.googleapis.com') {
    const op = /\/(accounts:[A-Za-z]+)$/.exec(path)?.[1];
    return op ? `auth: ${op}` : 'auth';
  }
  if (u.hostname === 'firestore.googleapis.com') return 'firestore';
  // Firebase Auth's popup/redirect helper (gapi loader and the authDomain
  // iframe) — not expected since Auth is created without it.
  if (u.hostname === 'apis.google.com') return 'auth: gapi';
  if (path === '/__/auth/iframe' || path === '/__/auth/iframe.js') return 'auth: iframe';
  // This app's own API, same origin only (a relative URL counts as same origin).
  const api = /^\/api\/([a-z]+)\/([A-Za-z]+)/.exec(path);
  const sameOrigin = u.hostname === 'app.invalid' || (typeof window !== 'undefined' && u.hostname === window.location.hostname);
  if (api && sameOrigin) return `api ${api[1]}/${api[2]}`;
  return null;
}

export type ResourceLike = {
  name: string; startTime: number; responseEnd: number; transferSize?: number; decodedBodySize?: number;
  serverTiming?: ReadonlyArray<{ name: string; duration: number }>;
};

// Sign-in and API calls are listed one by one (the first and the second
// accounts:lookup are different steps); everything else is grouped.
const listedSeparately = (label: string) => label.startsWith('auth') || label.startsWith('api ');
const SERVER_TIMING_NAME = /^[a-z]{2,16}$/;

/** Groups resource timings by label: first start, first end, how many. */
export function summarizeRequests(resources: ResourceLike[]): StartupRequest[] {
  const out = new Map<string, StartupRequest>();
  const occurrences = new Map<string, number>();
  for (const r of resources) {
    const label = requestLabel(r.name);
    if (!label) continue;
    const n = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, n);
    const name = listedSeparately(label) && n > 1 ? `${label} #${n}` : label;
    const seen = out.get(name);
    if (seen) { seen.count += 1; continue; }
    const item: StartupRequest = { name, start: Math.round(r.startTime), end: Math.round(r.responseEnd), count: 1 };
    const st = (r.serverTiming ?? []).filter(e => SERVER_TIMING_NAME.test(e.name));
    if (label.startsWith('api ') && st.length) item.serverTiming = st.map(e => ({ name: e.name, dur: Math.round(e.duration) }));
    // transferSize is 0 for a response served from the HTTP cache (when the
    // browser reports sizes at all — cross-origin responses may not).
    if (typeof r.transferSize === 'number' && typeof r.decodedBodySize === 'number' && r.decodedBodySize > 0) {
      item.cached = r.transferSize === 0;
    }
    out.set(name, item);
  }
  return Array.from(out.values()).sort((a, b) => a.start - b.start);
}

function saveRun(): void {
  try {
    const perf = typeof performance !== 'undefined' ? performance : null;
    const nav = perf?.getEntriesByType?.('navigation')?.[0] as (PerformanceEntry & {
      type?: string; responseEnd?: number; domContentLoadedEventEnd?: number; responseStart?: number;
      domainLookupStart?: number; domainLookupEnd?: number; connectStart?: number; connectEnd?: number;
    }) | undefined;
    const bundle = perf?.getEntriesByName?.('enma:index')?.[0];
    const authInit = perf?.getEntriesByName?.('enma:auth-init')?.[0];
    const fcp = perf?.getEntriesByName?.('first-contentful-paint')?.[0];
    const span = (a?: number, b?: number) => (typeof a === 'number' && typeof b === 'number' && b >= a ? Math.round(b - a) : undefined);
    const run: StartupRun = {
      recordedAt,
      navigationType: nav?.type ?? null,
      page: {
        htmlReceived: nav?.responseEnd ? Math.round(nav.responseEnd) : undefined,
        bundleStarted: bundle ? Math.round(bundle.startTime) : undefined,
        domReady: nav?.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : undefined,
        dns: span(nav?.domainLookupStart, nav?.domainLookupEnd),
        connect: span(nav?.connectStart, nav?.connectEnd),
        firstByte: nav?.responseStart ? Math.round(nav.responseStart) : undefined,
        firstContentfulPaint: fcp ? Math.round(fcp.startTime) : undefined,
        authInit: authInit ? Math.round(authInit.startTime) : undefined,
      },
      requests: summarizeRequests((perf?.getEntriesByType?.('resource') ?? []) as unknown as ResourceLike[]),
      marks: entries.slice(),
      auth: authState,
      traceId: traceId ?? undefined,
    };
    storage()?.setItem(LAST_RUN_KEY, JSON.stringify(run));
  } catch { /* diagnostics must never affect the app */ }
}
