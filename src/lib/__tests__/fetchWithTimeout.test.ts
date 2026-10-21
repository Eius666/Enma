import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, FetchTimeoutError } from '../fetchWithTimeout.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A fetch that never resolves until its signal aborts (like a stalled network).
function hangingFetch(calls: { signal?: AbortSignal | null }[] = []) {
  return (_input: unknown, init?: RequestInit) => {
    calls.push({ signal: init?.signal });
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (init?.signal?.aborted) abort(); // real fetch rejects immediately for an aborted signal
      else init?.signal?.addEventListener('abort', abort);
    });
  };
}

test('resolves normally and passes init through, with an abort signal attached', async () => {
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const res = await fetchWithTimeout('/api/x', { method: 'POST', headers: { a: 'b' }, body: '{}', timeoutMs: 1000 });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, '/api/x');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, { a: 'b' });
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.equal((calls[0].init as Record<string, unknown>).timeoutMs, undefined, 'timeoutMs must not leak into fetch init');
});

test('a stalled request is aborted and reported as TimeoutError (no endless wait)', async () => {
  const calls: { signal?: AbortSignal | null }[] = [];
  globalThis.fetch = hangingFetch(calls) as unknown as typeof fetch;
  const started = Date.now();
  await assert.rejects(fetchWithTimeout('/slow', { timeoutMs: 30 }), (e: Error) => e instanceof FetchTimeoutError && e.name === 'TimeoutError');
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls[0].signal?.aborted, true, 'the underlying request must be aborted (resource released)');
});

test('network errors are rethrown unchanged (not mislabelled as timeouts)', async () => {
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  await assert.rejects(fetchWithTimeout('/x', { timeoutMs: 1000 }), (e: Error) => e instanceof TypeError && !(e instanceof FetchTimeoutError));
});

test('a caller-provided signal still aborts the request', async () => {
  globalThis.fetch = hangingFetch() as unknown as typeof fetch;
  const ctl = new AbortController();
  const p = fetchWithTimeout('/x', { signal: ctl.signal, timeoutMs: 5000 });
  ctl.abort();
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
});

test('an already-aborted caller signal rejects immediately', async () => {
  globalThis.fetch = hangingFetch() as unknown as typeof fetch;
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(fetchWithTimeout('/x', { signal: ctl.signal, timeoutMs: 5000 }), (e: Error) => e.name === 'AbortError');
});

test('the timer is cleared after success (no dangling timers keep the process alive)', async () => {
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  await fetchWithTimeout('/x', { timeoutMs: 60_000 });
  const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  assert.equal(after, before);
});
