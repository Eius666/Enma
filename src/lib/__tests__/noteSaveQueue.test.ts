import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoteSaveQueue } from '../noteSaveQueue.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Debounce ─────────────────────────────────────────────────────────────────

test('schedule() debounces — rapid successive calls result in exactly one write, with the LAST payload', async () => {
  const calls: string[] = [];
  const q = createNoteSaveQueue<string>({
    write: async (p) => { calls.push(p); },
    debounceMs: 30,
  });

  q.schedule('A');
  await sleep(5);
  q.schedule('AB');
  await sleep(5);
  q.schedule('ABC');

  await sleep(60); // well past the debounce window
  assert.deepEqual(calls, ['ABC']); // not ['A','AB','ABC'] — only the final content was ever written
});

// ── Silent-loss-on-navigate-away fix ─────────────────────────────────────────

test('flush() submits a still-pending (not yet fired) debounce immediately — the exact "unmount" bug this was built to fix', async () => {
  const calls: string[] = [];
  const q = createNoteSaveQueue<string>({
    write: async (p) => { calls.push(p); },
    debounceMs: 5000, // deliberately long — would never fire on its own within this test
  });

  q.schedule('edited just before navigating away');
  const ok = await q.flush();

  assert.equal(ok, true);
  assert.deepEqual(calls, ['edited just before navigating away']); // NOT silently dropped
});

test('flush() with nothing pending resolves true and never calls write()', async () => {
  let callCount = 0;
  const q = createNoteSaveQueue<string>({ write: async () => { callCount++; } });
  const ok = await q.flush();
  assert.equal(ok, true);
  assert.equal(callCount, 0);
});

test('flush() while a write is already in flight waits for it to fully settle', async () => {
  const order: string[] = [];
  const q = createNoteSaveQueue<string>({
    write: async (p) => {
      order.push(`start:${p}`);
      await sleep(30);
      order.push(`end:${p}`);
    },
    debounceMs: 5,
  });

  q.schedule('X');
  await sleep(10); // let the debounce fire and the write start
  const ok = await q.flush(); // nothing newly pending, but X is still writing

  assert.equal(ok, true);
  assert.deepEqual(order, ['start:X', 'end:X']); // flush genuinely waited for it
});

// ── PHASE 7: the stale-write race itself ────────────────────────────────────

test('a slow earlier write never clobbers a faster later write — writes always land in REQUEST order', async () => {
  const store: { value: string | null } = { value: null };
  let concurrentWrites = 0;
  let maxConcurrent = 0;

  const q = createNoteSaveQueue<string>({
    write: async (p) => {
      concurrentWrites++;
      maxConcurrent = Math.max(maxConcurrent, concurrentWrites);
      // "A" (old content) is deliberately the SLOW one; "B" (new content)
      // is fast — exactly the scenario PHASE 7 describes.
      await sleep(p === 'A (old content)' ? 60 : 10);
      store.value = p;
      concurrentWrites--;
    },
    debounceMs: 0,
  });

  // Fire A, then — while A is still in flight — fire B.
  await q.flush(); // no-op, nothing scheduled yet
  const aPromise = (async () => { q.schedule('A (old content)'); await sleep(5); })();
  await aPromise;
  await sleep(2); // let A's debounce fire and its (slow) write begin
  q.schedule('B (new content)');
  const bFlush = await q.flush(); // forces B to submit now instead of waiting out its own debounce

  assert.equal(bFlush, true);
  assert.equal(maxConcurrent, 1); // never two writes in flight at once
  assert.equal(store.value, 'B (new content)'); // NOT reverted to the old content once A's slow write finally lands
});

// ── Status callbacks ─────────────────────────────────────────────────────────

test('status goes saving -> saved on success, and saving -> error on failure (text is never cleared by this module either way)', async () => {
  const statuses: string[] = [];
  let shouldFail = false;
  const q = createNoteSaveQueue<string>({
    write: async () => { if (shouldFail) throw new Error('network down'); },
    onStatusChange: (s) => statuses.push(s),
    debounceMs: 0,
  });

  q.schedule('ok');
  await q.flush();
  assert.deepEqual(statuses, ['saving', 'saved']);

  shouldFail = true;
  statuses.length = 0;
  q.schedule('will fail');
  const ok = await q.flush();
  assert.equal(ok, false);
  assert.deepEqual(statuses, ['saving', 'error']);
});

test('after a failed write, scheduling again (retry) still works normally', async () => {
  let attempt = 0;
  const calls: string[] = [];
  const q = createNoteSaveQueue<string>({
    write: async (p) => {
      attempt++;
      if (attempt === 1) throw new Error('transient');
      calls.push(p);
    },
    debounceMs: 0,
  });

  q.schedule('retry me');
  const first = await q.flush();
  assert.equal(first, false);

  q.schedule('retry me');
  const second = await q.flush();
  assert.equal(second, true);
  assert.deepEqual(calls, ['retry me']);
});

// ── Two sequential vs two parallel edits ────────────────────────────────────

test('two sequential edits after the first write already completed each get their own write', async () => {
  const calls: string[] = [];
  const q = createNoteSaveQueue<string>({ write: async (p) => { calls.push(p); }, debounceMs: 5 });

  q.schedule('edit 1');
  await sleep(20);
  q.schedule('edit 2');
  await sleep(20);

  assert.deepEqual(calls, ['edit 1', 'edit 2']);
});

test('two "parallel" submissions (second arrives while the first is still in flight) coalesce into one follow-up write, never run concurrently', async () => {
  const calls: string[] = [];
  let concurrent = 0, maxConcurrent = 0;
  const q = createNoteSaveQueue<string>({
    write: async (p) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(20);
      calls.push(p);
      concurrent--;
    },
    debounceMs: 0,
  });

  q.schedule('first');
  await sleep(2); // let the first write start
  q.schedule('second'); // arrives while "first" is still writing
  await q.flush();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(calls, ['first', 'second']); // second is coalesced, runs right after, never dropped
});

// ── hasPendingWork / cancelPendingDebounce ──────────────────────────────────

test('hasPendingWork reflects a scheduled-but-unfired debounce, an in-flight write, and settles back to false', async () => {
  const q = createNoteSaveQueue<string>({ write: async () => { await sleep(20); }, debounceMs: 30 });
  assert.equal(q.hasPendingWork(), false);
  q.schedule('x');
  assert.equal(q.hasPendingWork(), true);
  await q.flush();
  assert.equal(q.hasPendingWork(), false);
});

test('cancelPendingDebounce drops an unfired debounce without writing it (distinct from flush)', async () => {
  let callCount = 0;
  const q = createNoteSaveQueue<string>({ write: async () => { callCount++; }, debounceMs: 20 });
  q.schedule('should never be written');
  q.cancelPendingDebounce();
  await sleep(40);
  assert.equal(callCount, 0);
});

// ── cancelAndWait — the delete-safety guarantee ─────────────────────────────

test('cancelAndWait discards a pending debounce without writing it (would otherwise resurrect a just-deleted note)', async () => {
  const calls: string[] = [];
  const q = createNoteSaveQueue<string>({ write: async (p) => { calls.push(p); }, debounceMs: 20 });
  q.schedule('edit right before delete');
  await q.cancelAndWait();
  await sleep(40); // long enough that the old debounce WOULD have fired if not cancelled
  assert.deepEqual(calls, []); // never written — delete gets the last word
});

test('cancelAndWait still waits for a write that was ALREADY in flight before returning', async () => {
  const order: string[] = [];
  const q = createNoteSaveQueue<string>({
    write: async (p) => { order.push(`start:${p}`); await sleep(30); order.push(`end:${p}`); },
    debounceMs: 0,
  });
  q.schedule('already saving');
  await sleep(5); // let it start
  await q.cancelAndWait();
  assert.deepEqual(order, ['start:already saving', 'end:already saving']); // delete waits for it, so it can't land after the delete
});
