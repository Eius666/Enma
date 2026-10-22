'use strict';

// Read-only smoke check of the DEV deployment, run by hand after a DEV release:
//   node scripts/dev-smoke.js
//
// What it does: a fixed list of anonymous requests that must be refused or
// answered without side effects (no credentials are sent, no payment route
// except the read-only version probe, nothing that writes data or messages
// anyone). It prints check names, HTTP statuses and the deployed build id —
// never response bodies.
//
// It refuses to run against anything but the pinned DEV deployment.

const DEV_BASE = 'https://enma-l4lh.vercel.app';
const TIMEOUT_MS = 15_000;

// [name, method, path, body | undefined, accept(status, json) → true | reason]
const CHECKS = [
  ['app shell is served', 'GET', '/', undefined, (s, _j, text) => s === 200 && /<div id="root">/.test(text) || `status ${s}`],
  ['build id is published', 'GET', '/api/payment/version', undefined, (s, j) => (s === 200 && j && typeof j.buildId === 'string' && j.buildId.length > 0) || `status ${s}`],
  ['cron refuses a call without the secret', 'GET', '/api/telegram/cron', undefined, (s) => s === 401 || `status ${s} (expected 401)`],
  ['webhook refuses an update without the secret header', 'POST', '/api/telegram/webhook', {}, (s) => s === 401 || `status ${s} (expected 401)`],
  ['ai router: GET is not allowed', 'GET', '/api/ai/adminStats', undefined, (s) => s === 405 || `status ${s} (expected 405)`],
  ['ai router: admin action without key is forbidden', 'POST', '/api/ai/adminStats', {}, (s) => s === 403 || `status ${s} (expected 403)`],
  ['ai router: user action without token is unauthorized', 'POST', '/api/ai/entityCreate', {}, (s) => s === 401 || `status ${s} (expected 401)`],
  ['ai router: unknown action is 404', 'POST', '/api/ai/noSuchAction', {}, (s) => s === 404 || `status ${s} (expected 404)`],
  ['insights without token is unauthorized', 'GET', '/api/insights/list', undefined, (s) => s === 401 || `status ${s} (expected 401)`],
  ['cron router: unknown job is 404', 'GET', '/api/cron/no-such-job', undefined, (s) => s === 404 || `status ${s} (expected 404)`],
];

function assertDevBase(base) {
  if (base !== DEV_BASE) throw new Error(`refusing to run: only ${DEV_BASE} is allowed`);
}

async function runSmoke({ base = DEV_BASE, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  assertDevBase(base);
  const results = [];
  let buildId = null;
  for (const [name, method, path, body, accept] of CHECKS) {
    let status = 0; let json = null; let text = '';
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: body === undefined ? { accept: 'application/json, text/html' } : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
      try { json = JSON.parse(text); } catch { json = null; }
    } catch (err) {
      results.push({ name, ok: false, detail: `request failed (${err && err.name ? err.name : 'Error'})` });
      continue;
    }
    const verdict = accept(status, json, text);
    if (path === '/api/payment/version' && json && typeof json.buildId === 'string') buildId = json.buildId.slice(0, 64);
    results.push({ name, ok: verdict === true, detail: verdict === true ? `status ${status}` : String(verdict) });
  }
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
  log(`build id: ${buildId ?? 'unknown'}`);
  return { ok: results.every(r => r.ok), results, buildId };
}

module.exports = { runSmoke, CHECKS, DEV_BASE, assertDevBase };

if (require.main === module) {
  runSmoke().then(r => { process.exitCode = r.ok ? 0 : 1; }).catch(err => { console.error(err.message); process.exitCode = 1; });
}
