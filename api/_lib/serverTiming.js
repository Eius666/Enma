'use strict';

// Per-request phase timings, DEV only, for diagnosing slow sign-in.
//
// Monotonic clock (process.hrtime), phase names and milliseconds only — never
// ids, tokens, initData or anything about the user. In DEV the timings go out
// as a standard Server-Timing response header (the startup diagnostics on the
// device read it) and as one log line; anywhere else nothing is emitted.
//
// A trace id the client may send (X-Enma-Trace, 16 hex characters, random per
// attempt) only lets that log line be matched with the device's diagnostics.
// It is never used for anything else, and a value of any other shape is
// dropped.

const { getEnvName } = require('./envIsolation');

let invocations = 0;

function timingEnabled() {
  try { return getEnvName() === 'dev'; } catch { return false; }
}

const msSince = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const TRACE_RE = /^[0-9a-f]{16}$/;

function readTrace(req) {
  const raw = req && req.headers ? req.headers['x-enma-trace'] : undefined;
  return typeof raw === 'string' && TRACE_RE.test(raw) ? raw : null;
}

/**
 * startup: optional { boot, modinit, admin } durations (ms) known for this
 * instance — reported only on its first (cold) invocation.
 */
function createRequestTimer(req, startup = {}) {
  const enabled = timingEnabled();
  const trace = enabled ? readTrace(req) : null;
  const cold = invocations === 0;
  invocations += 1;
  const t0 = process.hrtime.bigint();
  let last = t0;
  const entries = [];
  if (cold) {
    entries.push(['cold', 0]);
    for (const [name, ms] of Object.entries(startup)) {
      if (typeof ms === 'number' && Number.isFinite(ms)) entries.push([name, ms]);
    }
  }

  return {
    enabled,
    cold,
    /** Time since the previous phase() (or the start). Sequential steps. */
    phase(name) {
      const now = process.hrtime.bigint();
      entries.push([name, Number(now - last) / 1e6]);
      last = now;
    },
    /** Duration of one awaited operation; operations may overlap. */
    async time(name, fn) {
      const s = process.hrtime.bigint();
      try { return await fn(); } finally { entries.push([name, msSince(s)]); last = process.hrtime.bigint(); }
    },
    /** Sets Server-Timing and writes the log line (DEV only). */
    finish(res, outcome) {
      if (!enabled) return;
      const all = [...entries, ['total', msSince(t0)]];
      const header = all.map(([n, d]) => `${n};dur=${d.toFixed(1)}`).join(', ');
      try { res.setHeader('Server-Timing', header); } catch { /* headers already sent */ }
      const phases = Object.fromEntries(all.map(([n, d]) => [n, Math.round(d * 10) / 10]));
      console.log(`[auth/telegram] timing ${JSON.stringify({ trace, cold, outcome, phases })}`);
    },
  };
}

module.exports = { createRequestTimer, readTrace, timingEnabled };
