'use strict';

// api/cron/[job].js — the single Vercel Function behind all /api/cron/<job>
// endpoints (Hobby plan: max 12 Functions per deployment). Covers routing, the
// allowlist, that each handler's own CRON_SECRET check still runs, HTTP-method
// behaviour, and backward compatibility of URLs / vercel.json / file layout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const ROOT = path.join(__dirname, '..', '..', '..');
const ROUTER = require.resolve('../[job]');
const JOBS = ['content-plan', 'content-publish', 'maintenance', 'insights'];
const SECRET = 'cron-secret-for-tests-0123456789';

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {}, end() { return this; },
  };
}
const req = (job, extra = {}) => ({ method: 'POST', headers: {}, query: {}, url: `/api/cron/${job}`, ...extra });

function freshRouter({ stubs = false, secret = SECRET, enmaEnv } = {}) {
  const saved = process.env.CRON_SECRET;
  const savedEnv = process.env.ENMA_ENV;
  if (enmaEnv === undefined) delete process.env.ENMA_ENV; else process.env.ENMA_ENV = enmaEnv;
  if (secret === null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: createMockDb({}), admin: mockAdmin } };
  const calls = [];
  for (const j of JOBS) {
    const p = require.resolve(`../../_cron/${j}`);
    delete require.cache[p];
    if (stubs) {
      require.cache[p] = { id: p, filename: p, loaded: true, exports: async (rq, rs) => { calls.push(j); rs.status(200).json({ stub: j }); return `ret:${j}`; } };
    }
  }
  delete require.cache[ROUTER];
  delete require.cache[require.resolve('../../_lib/envIsolation')];
  const router = require('../[job]');
  const restore = () => {
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    if (savedEnv === undefined) delete process.env.ENMA_ENV; else process.env.ENMA_ENV = savedEnv;
    delete require.cache[fa];
    for (const j of JOBS) { try { delete require.cache[require.resolve(`../../_cron/${j}`)]; } catch (_) {} }
    delete require.cache[ROUTER];
  };
  return { router, calls, restore };
}

// ── routing ─────────────────────────────────────────────────────────────────

test('each public URL reaches exactly its own handler, with the original req/res', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true });
  t.after(restore);
  for (const job of JOBS) {
    calls.length = 0;
    const res = mockRes();
    const ret = await router(req(job), res);
    assert.deepEqual(calls, [job], job);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { stub: job });
    assert.equal(ret, `ret:${job}`, 'handler return value is passed through');
  }
});

test('trailing slash and query string still route; the job comes from the path, not ?job=', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true });
  t.after(restore);
  await router(req('maintenance', { url: '/api/cron/maintenance/?type=cleanup' }), mockRes());
  await router(req('maintenance', { url: '/api/cron/maintenance?job=insights', query: { job: 'insights' } }), mockRes());
  assert.deepEqual(calls, ['maintenance', 'maintenance']);
});

test('rewritten-URL runtimes: `/api/cron/[job]?job=<name>` routes by the allowlisted query value; arrays and unknown values 404', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true });
  t.after(restore);
  for (const job of JOBS) {
    calls.length = 0;
    await router({ method: 'POST', headers: {}, query: { job }, url: `/api/cron/[job]?job=${job}` }, mockRes());
    assert.deepEqual(calls, [job]);
  }
  calls.length = 0;
  for (const q of [{ job: 'nope' }, { job: ['maintenance', 'insights'] }, { job: '__proto__' }, {}]) {
    const res = mockRes();
    await router({ method: 'POST', headers: {}, query: q, url: '/api/cron/[job]' }, res);
    assert.equal(res.statusCode, 404, JSON.stringify(q));
  }
  assert.deepEqual(calls, []);
  // the fallback applies only to the literal placeholder segment, never to a named path
  const res = mockRes();
  await router({ method: 'POST', headers: {}, query: { job: 'insights' }, url: '/api/cron/nope' }, res);
  assert.equal(res.statusCode, 404);
});

test('allowlist: unknown / malformed / traversal-like jobs answer 404 and load nothing', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true });
  t.after(restore);
  const bad = ['nope', 'MAINTENANCE', 'Insights', 'maintenance.js', '..%2F_lib%2Ftools', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '%00', 'maintenance%2Finsights'];
  for (const job of bad) {
    const res = mockRes();
    await router(req(job), res);
    assert.equal(res.statusCode, 404, job);
    assert.deepEqual(res.body, { ok: false, error: 'unknown_cron_job' });
  }
  for (const url of ['/api/cron/', '/api/cron', '/api/cron/maintenance/extra', '/api/cron//maintenance', '/other/maintenance', '', undefined]) {
    const res = mockRes();
    await router({ method: 'POST', headers: {}, query: { job: 'maintenance' }, url }, res);
    assert.equal(res.statusCode, 404, String(url));
  }
  assert.deepEqual(calls, [], 'no handler may run for a rejected job');
});

// ── DEV fail-closed (ENMA_ENV=dev) ───────────────────────────────────────────

test('DEV without CRON_SECRET → 503 for every job, and NO handler runs (even with a bearer header)', async (t) => {
  for (const secret of [null, '', '   ']) {
    const { router, calls, restore } = freshRouter({ stubs: true, secret, enmaEnv: 'dev' });
    for (const job of JOBS) {
      for (const rq of [req(job), req(job, { method: 'GET' }), req(job, { headers: { authorization: 'Bearer anything' } })]) {
        const res = mockRes();
        await router(rq, res);
        assert.equal(res.statusCode, 503, `${job} secret=${JSON.stringify(secret)}`);
        assert.deepEqual(res.body, { ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' });
      }
    }
    assert.deepEqual(calls, []);
    restore();
  }
});

test('DEV with a secret: wrong or missing credentials → 401 from the real handlers; correct credentials pass the gate', async (t) => {
  const { router, restore } = freshRouter({ enmaEnv: 'dev' });
  t.after(restore);
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const quiet = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {};
  t.after(() => { global.fetch = origFetch; [console.log, console.error, console.warn] = quiet; });
  for (const job of JOBS) {
    for (const rq of [req(job), req(job, { headers: { authorization: 'Bearer wrong' } }), req(job, { query: { secret: 'wrong' }, url: `/api/cron/${job}?secret=wrong` })]) {
      const res = mockRes();
      await router(rq, res);
      assert.equal(res.statusCode, 401, job);
    }
  }
  for (const job of ['insights', 'maintenance']) {
    const res = mockRes();
    await router(req(job, { headers: { authorization: `Bearer ${SECRET}` }, query: { type: 'cleanup' }, url: `/api/cron/${job}?type=cleanup` }), res);
    assert.notEqual(res.statusCode, 401, job);
    assert.notEqual(res.statusCode, 503, job);
  }
});

test('DEV: a job is not executed before authorization succeeds (stub handler never called for unauthenticated 503)', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true, secret: null, enmaEnv: 'dev' });
  t.after(restore);
  await router(req('maintenance'), mockRes());
  assert.deepEqual(calls, []);
});

test('unrecognised ENMA_ENV fails closed with 503; unknown jobs still 404 first', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true, enmaEnv: 'staging' });
  t.after(restore);
  const res = mockRes();
  await router(req('maintenance'), res);
  assert.equal(res.statusCode, 503);
  const res2 = mockRes();
  await router(req('nope'), res2);
  assert.equal(res2.statusCode, 404);
  assert.deepEqual(calls, []);
});

test('production (ENMA_ENV unset) is unchanged: no secret → handlers decide (as before), nothing returns 503 from the router', async (t) => {
  const { router, calls, restore } = freshRouter({ stubs: true, secret: null });
  t.after(restore);
  for (const job of JOBS) {
    const res = mockRes();
    await router(req(job), res);
    assert.equal(res.statusCode, 200, job);
  }
  assert.deepEqual(calls, JOBS);
});

// ── authorization is still enforced by each real handler ─────────────────────

test('real handlers: no credentials → 401 for every job (router adds no bypass)', async (t) => {
  const { router, restore } = freshRouter();
  t.after(restore);
  for (const job of JOBS) {
    for (const rq of [req(job), req(job, { method: 'GET' })]) {
      const res = mockRes();
      await router(rq, res);
      assert.equal(res.statusCode, 401, `${job} ${rq.method}`);
      assert.equal(res.body.error, 'unauthorized');
    }
  }
});

test('real handlers: wrong header/query secret → 401; ?job= cannot swap in another handler to dodge auth', async (t) => {
  const { router, restore } = freshRouter();
  t.after(restore);
  for (const job of JOBS) {
    for (const rq of [
      req(job, { headers: { authorization: 'Bearer wrong' } }),
      req(job, { query: { secret: 'wrong' }, url: `/api/cron/${job}?secret=wrong` }),
      req(job, { headers: { authorization: `Bearer ${SECRET}x` } }),
      req(job, { query: { job: 'insights' }, url: `/api/cron/${job}?job=insights` }),
    ]) {
      const res = mockRes();
      await router(rq, res);
      assert.equal(res.statusCode, 401, job);
    }
  }
});

test('real handlers: a correct secret passes the auth gate (not 401) — same as before the consolidation', async (t) => {
  const { router, restore } = freshRouter();
  t.after(restore);
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  t.after(() => { global.fetch = origFetch; });
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  t.after(() => { console.log = origLog; console.error = origErr; console.warn = origWarn; });
  for (const job of ['insights', 'maintenance']) {
    const res = mockRes();
    await router(req(job, { headers: { authorization: `Bearer ${SECRET}` }, url: `/api/cron/${job}?type=cleanup` , query: { type: 'cleanup' } }), res);
    assert.notEqual(res.statusCode, 401, job);
  }
});

// ── HTTP methods keep the handler's own behaviour ────────────────────────────

test('insights still rejects methods other than GET/POST with 405; the others do not restrict methods', async (t) => {
  const { router, restore } = freshRouter();
  t.after(restore);
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const res = mockRes();
    await router(req('insights', { method: m }), res);
    assert.equal(res.statusCode, 405, m);
  }
  for (const job of ['content-plan', 'content-publish', 'maintenance']) {
    const res = mockRes();
    await router(req(job, { method: 'PUT' }), res);
    assert.equal(res.statusCode, 401, `${job}: no method gate in the original handler; auth runs first`);
  }
});

// ── backward compatibility of layout and configuration ───────────────────────

test('file layout: only [job].js under api/cron; handlers moved to the underscore dir', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'api/cron')).filter((f) => f.endsWith('.js')), ['[job].js']);
  for (const j of JOBS) assert.ok(fs.existsSync(path.join(ROOT, `api/_cron/${j}.js`)), j);
  assert.deepEqual([...require('../[job]').JOBS].sort(), [...JOBS].sort());
});

test('vercel.json: every functions pattern matches a real file; [job].js keeps maxDuration >= 30 (old value)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const p of Object.keys(cfg.functions)) assert.ok(fs.existsSync(path.join(ROOT, p)), `unmatched pattern ${p}`);
  assert.ok(cfg.functions['api/cron/[job].js'].maxDuration >= 30);
  for (const old of JOBS) assert.equal(cfg.functions[`api/cron/${old}.js`], undefined);
  assert.ok(!JSON.stringify(cfg).includes('"crons"'), 'no scheduler config was introduced');
});

test('function budget: Vercel entry points (no leading-underscore path segment) stay well under the Hobby cap', () => {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(js|ts|mjs|cjs)$/.test(e.name)) out.push(path.relative(ROOT, p));
    }
  })(path.join(ROOT, 'api'));
  assert.equal(out.length, 9, out.join(', '));
  assert.ok(out.length + 1 /* middleware */ <= 11, 'keep at least one slot free under the 12-function cap');
});

test('no stale references to the old cron file paths in code, docs or workflows', () => {
  const stale = /api\/cron\/(content-plan|content-publish|maintenance|insights)\.js|require\(['"]\.\.\/cron\//;
  const hits = [];
  for (const dir of ['api', 'src', 'scripts', 'docs', '.github', 'functions/src']) {
    (function walk(d) {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|ts|tsx|md|json|ya?ml)$/.test(e.name) && stale.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
      }
    })(path.join(ROOT, dir));
  }
  assert.deepEqual(hits, []);
});
