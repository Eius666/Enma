'use strict';

// Characterization ("golden master") harness for server modules.
//
// Each scenario runs the REAL code (an HTTP handler, or functions of a module)
// on a fresh module graph against an in-memory Firestore, with everything that
// is not deterministic pinned: the clock, Math.random, crypto random bytes,
// the network (a scripted fake fetch) and process.env. What callers and the
// database observe — status, headers and body (or a return value), the
// Firestore writes of every step, outgoing HTTP calls and log lines — is
// recorded in a canonical JSON form so that a refactor can be checked for
// byte-identical external behaviour.
//
// Nothing here talks to the network or to a real Firebase project.

const path = require('node:path');
const crypto = require('node:crypto');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const API_DIR = path.resolve(__dirname, '..', '..') + path.sep;
const KEEP = new Set([
  require.resolve('../../_lib/evals/fixtures'),
  __filename,
]);

const NOW = Date.UTC(2026, 9, 15, 9, 30, 0); // 2026-10-15T09:30:00Z, a Thursday
const BOT_TOKEN = '123456:TEST-BOT-TOKEN';
const ADMIN_KEY = 'test-admin-key';

const BASE_ENV = {
  TZ: 'UTC',
  ADMIN_API_KEY: ADMIN_KEY,
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  PARTNER_SESSION_SECRET: 'test-partner-session-secret',
};
// Variables that would change behaviour if inherited from the shell.
const SCRUB_ENV = [
  'ADMIN_TOTP_SECRET', 'TELEGRAM_BOT_USERNAME', 'ENMA_ENV', 'VERCEL_ENV', 'KV_REST_API_URL',
  'STARS_MINIAPP_ENABLED', 'STARS_CANARY_TELEGRAM_IDS', 'STARS_RECURRING_ENABLED', 'LEGACY_STARS_BOT_INVOICE_ENABLED',
  'FIRESTORE_EMULATOR_HOST', 'OPENROUTER_API_KEY', 'DEV_ALLOWED_CHAT_IDS', 'CRON_SECRET', 'REACT_APP_URL',
  'PARTNER_BONUS_ENABLED', 'PARTNER_BONUS_MILESTONES', 'ADMIN_TELEGRAM_IDS',
];

// ── deterministic sources ───────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFixedDate(RealDate, nowRef) {
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowRef.value);
      else super(...args);
    }
    static now() { return nowRef.value; }
  }
  return FixedDate;
}

// ── canonical serialisation ─────────────────────────────────────────────────

function canon(v, seen = new Set()) {
  if (v === undefined) return '$undefined';
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : `$number:${String(v)}`;
  if (typeof v === 'bigint') return `$bigint:${v}`;
  if (typeof v === 'function') return '$function';
  if (Buffer.isBuffer(v)) {
    return { $buffer: { bytes: v.length, sha256: crypto.createHash('sha256').update(v).digest('hex'), head: v.subarray(0, 5).toString('latin1') } };
  }
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() };
  if (typeof v.toMillis === 'function' && typeof v.toDate === 'function' && v.constructor && v.constructor.name === 'MockTimestamp') {
    return { $ts: new Date(v.toMillis()).toISOString() };
  }
  if (seen.has(v)) return '$circular';
  seen.add(v);
  let out;
  if (Array.isArray(v)) out = v.map(x => canon(x, seen));
  else {
    out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k], seen);
  }
  seen.delete(v);
  return out;
}

function redact(s) {
  return String(s).split(BOT_TOKEN).join('<BOT_TOKEN>');
}

function fmtLogArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') {
    const i = a.indexOf('\n    at ');
    return redact(i >= 0 ? a.slice(0, i) : a);
  }
  try { return redact(JSON.stringify(canon(a))); } catch { return '$unserialisable'; }
}

// ── Firestore helpers ───────────────────────────────────────────────────────

function dbSnapshot(db) {
  const out = {};
  for (const k of [...db._store.keys()].sort()) out[k] = JSON.stringify(canon(db._store.get(k)));
  return out;
}

function dbDiff(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    if (!(k in after)) changes[k] = '$deleted';
    else if (before[k] !== after[k]) changes[k] = JSON.parse(after[k]);
  }
  return changes;
}

// Makes chosen collections throw on access — exercises the router's error paths.
function withFailures(db, failures) {
  if (!failures || !failures.length) return db;
  const collection = db.collection;
  return {
    ...db,
    collection(name) {
      const f = failures.find(x => x.collection === name);
      if (f) throw Object.assign(new Error(f.message || `forced failure: ${name}`), f.statusCode ? { statusCode: f.statusCode } : {});
      return collection(name);
    },
  };
}

// ── fake network ────────────────────────────────────────────────────────────

function makeFetch(routes, calls) {
  return async (url, init = {}) => {
    const u = String(url);
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep text */ } }
    else if (typeof FormData !== 'undefined' && body instanceof FormData) {
      body = { $formData: [...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { $blob: { type: v.type, bytes: v.size, name: v.name } }]) };
    }
    calls.push({ url: redact(u), method: init.method || 'GET', body: body === undefined ? '$none' : canon(body) });
    const route = (routes || []).find(r => (
      typeof r.match === 'function' ? r.match(u, body)
        : r.match instanceof RegExp ? r.match.test(u) : u.includes(r.match)));
    if (!route) throw new TypeError('fetch failed (no scripted route)');
    if (route.throw) throw new TypeError(route.throw);
    const status = route.status || 200;
    const payload = route.json;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => (payload === undefined ? {} : JSON.parse(JSON.stringify(payload))),
      text: async () => JSON.stringify(payload ?? {}),
    };
  };
}

// ── response double ─────────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 200, body: '$none', headers: {}, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = { json: canon(p) }; this.ended = true; return this; },
    send(p) { this.body = { send: canon(p) }; this.ended = true; return this; },
    end(p) { this.body = { end: canon(p) }; this.ended = true; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = canon(v); },
  };
}

// ── runner ──────────────────────────────────────────────────────────────────

function freshModuleGraph(db, admin, entry) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(API_DIR) && !KEEP.has(k)) delete require.cache[k];
  }
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: {
      db, admin,
      getBucket: () => { throw new Error('storage is not available in tests'); },
      getUserTimezone: async () => 'Europe/Moscow',
      getUserCurrency: async () => 'RUB',
    },
  };
  return require(entry);
}

function makeAdmin(tokens) {
  return {
    ...mockAdmin,
    auth: () => ({
      verifyIdToken: async (token) => {
        const m = /^tok-(.+)$/.exec(String(token));
        if (!m || (tokens && !tokens.includes(m[1]))) throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
        return { uid: m[1] };
      },
    }),
  };
}

// target.entry: absolute path of the module to load on the fresh graph.
// target.kind: 'http' (steps are requests to a (req, res) handler) or 'call'
// (steps are { call: (mod, history) => value } run against the module).
async function runScenario(scenario, target) {
  const RealDate = global.Date;
  const realRandom = Math.random;
  const realRandomBytes = crypto.randomBytes;
  const realRandomUUID = crypto.randomUUID;
  const realFetch = global.fetch;
  const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const savedEnv = { ...process.env };

  const nowRef = { value: scenario.now ?? NOW };
  const rnd = mulberry32(scenario.seedRandom ?? 42);
  const logs = [];
  const fetchCalls = [];

  try {
    for (const k of SCRUB_ENV) delete process.env[k];
    Object.assign(process.env, BASE_ENV);
    for (const [k, v] of Object.entries(scenario.env || {})) {
      if (v === null) delete process.env[k]; else process.env[k] = v;
    }
    global.Date = makeFixedDate(RealDate, nowRef);
    Math.random = rnd;
    crypto.randomBytes = (n, cb) => {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
      if (typeof cb === 'function') { cb(null, b); return undefined; }
      return b;
    };
    crypto.randomUUID = () => {
      const h = crypto.randomBytes(16).toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    global.fetch = makeFetch(scenario.fetch, fetchCalls);
    for (const level of ['log', 'warn', 'error', 'info']) {
      console[level] = (...args) => logs.push(`${level}: ${args.map(fmtLogArg).join(' ')}`);
    }

    const seed = typeof scenario.seed === 'function' ? scenario.seed({ ts, NOW }) : (scenario.seed || {});
    const baseDb = createMockDb(seed);
    const db = withFailures(baseDb, scenario.failures);
    let before = dbSnapshot(baseDb);
    const mod = freshModuleGraph(db, makeAdmin(scenario.tokens), target.entry);

    const steps = scenario.steps || [scenario.request];
    const results = [];
    const history = [];
    for (const rawStep of steps) {
      const step = typeof rawStep === 'function' ? rawStep(history) : rawStep;
      if (step.advanceMs) nowRef.value += step.advanceMs;
      const callsBefore = fetchCalls.length;
      const logsBefore = logs.length;
      let outcome;
      if (target.kind === 'call') {
        outcome = {};
        try { outcome.returned = canon(await step.call(mod, history)); } catch (err) { outcome.thrown = `${err.name}: ${err.message}`; }
        history.push(outcome.returned);
      } else {
        const r = mockRes();
        const req = {
          method: step.method || 'POST',
          query: { [target.queryKey || 'action']: step.action, ...(step.query || {}) },
          headers: { 'x-forwarded-for': '203.0.113.10', ...(step.headers || {}) },
          body: step.body === undefined ? {} : step.body,
          url: `${target.urlPrefix || '/api/ai/'}${step.action}`,
        };
        let thrown = null;
        try { await mod(req, r); } catch (err) { thrown = `${err.name}: ${err.message}`; }
        history.push(r);
        outcome = { status: r.statusCode, headers: r.headers, body: r.body, ...(thrown ? { thrown } : {}) };
      }
      const after = dbSnapshot(baseDb);
      results.push({
        ...outcome,
        writes: dbDiff(before, after),
        fetch: fetchCalls.slice(callsBefore),
        logs: logs.slice(logsBefore),
      });
      before = after;
    }

    return { steps: results };
  } finally {
    global.Date = RealDate;
    Math.random = realRandom;
    crypto.randomBytes = realRandomBytes;
    crypto.randomUUID = realRandomUUID;
    global.fetch = realFetch;
    Object.assign(console, realConsole);
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
}

const ts = (iso) => mockAdmin.firestore.Timestamp.fromMillis(typeof iso === 'number' ? iso : Date.parse(iso));

// ── Telegram signatures for fixtures (independent re-implementations) ──────

function miniAppInitData(user, authDate) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAHtest');
  params.set('user', JSON.stringify(user));
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

function loginWidgetPayload(fields) {
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  return { ...fields, hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') };
}

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const c of s.toUpperCase()) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secretB32, atMs, step = 0) {
  const counter = Math.floor(atMs / 30000) + step;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

function partnerToken(code, expMs) {
  const b64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = b64(Buffer.from(JSON.stringify({ code, exp: expMs }), 'utf8'));
  const sig = b64(crypto.createHmac('sha256', BASE_ENV.PARTNER_SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

module.exports = { runScenario, ts, NOW, BOT_TOKEN, ADMIN_KEY, miniAppInitData, loginWidgetPayload, totp, partnerToken };
