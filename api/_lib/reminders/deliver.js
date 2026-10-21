'use strict';

// Delivery of due Telegram reminders from the `reminders` collection.
//
// Lifecycle of a document:
//   pending --claim--> sending --sent------------------> sent
//                         |----transient failure------> pending (backoff, retryCount+1)
//                         |----attempts exhausted-----> failed  (retries_exhausted)
//                         |----permanent failure------> failed  (recipient_* / telegram_*)
//                         |----lease expired (crash)--> pending (retryCount+1) or failed
//   pending, far past its time ------------------------> expired (never sent, never deleted)
//
// DELIVERY SEMANTICS: at-least-once with a bounded number of attempts.
// The claim is a Firestore transaction, so two workers never hold the same
// reminder at once. That does NOT make delivery exactly-once: Telegram's
// sendMessage has no idempotency key, so if a worker dies (or the network
// drops the reply) AFTER Telegram accepted the message but BEFORE the result
// is written, the lease eventually expires and the reminder is attempted
// again — the user can receive a duplicate. A missed reminder is judged worse
// than a rare duplicate; every attempt is counted in `retryCount` so a
// duplicate can be traced. Logs contain document ids, states and error codes
// only — never message text, titles or chat ids.

const crypto = require('crypto');

const LEASE_MS         = 3 * 60 * 1000;        // a claim is valid for 3 minutes
const MAX_ATTEMPTS     = 5;                    // total send attempts per reminder
const MAX_LATE_MS      = 2 * 60 * 60 * 1000;   // older than this past its time: expired, not sent
const SCAN_LIMIT       = 200;                  // documents read per status per run
const MAX_SEND_PER_RUN = 25;
const MAX_EXPIRE_PER_RUN = 50;
const MAX_RECLAIM_PER_RUN = 25;
const TIME_BUDGET_MS   = 20 * 1000;            // stop starting new sends after this
const MAX_TEXT_LENGTH  = 4096;

const toMillis = (v) => {
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  return new Date(v).getTime();
};

/** Seconds: 60, 120, 240, … capped at one hour. `failures` >= 1. */
const backoffMs = (failures) => Math.min(60 * 2 ** (failures - 1), 3600) * 1000;

const validChatId = (chatId) => /^-?[0-9]{1,16}$/.test(String(chatId ?? ''));

/**
 * Maps the outcome of a Telegram call to what we do next.
 * @returns {{kind:'sent'|'retry'|'terminal', code:string, retryAfterMs?:number, stopBatch?:boolean}}
 */
function classifySendResult(result) {
  if (result && result.ok) return { kind: 'sent', code: 'ok' };
  const status = result && result.status;
  const description = String((result && result.payload && result.payload.description) || '').slice(0, 120);
  if (status === 429) {
    const retryAfter = Number(result.payload?.parameters?.retry_after);
    return { kind: 'retry', code: 'telegram_429', retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined };
  }
  if (status === 401) return { kind: 'retry', code: 'telegram_401_bot_token', stopBatch: true };
  if (status === 400 || status === 403 || status === 404) {
    return { kind: 'terminal', code: `telegram_${status}`, detail: description };
  }
  return { kind: 'retry', code: `telegram_${status || 'unknown'}`, detail: description };
}

/** A thrown error from the transport. DEV egress/allow-list refusals are permanent; everything else is retried. */
function classifyThrown(error) {
  const code = error && error.code;
  if (error && (error.name === 'EnvIsolationError' || (typeof code === 'string' && code.startsWith('DEV_')))) {
    return { kind: 'terminal', code: 'recipient_blocked_by_env_guard' };
  }
  const name = error && error.name === 'TimeoutError' ? 'timeout' : 'network';
  return { kind: 'retry', code: `send_${name}` };
}

const reminderText = (data) => {
  let text;
  if (data.telegramText) text = String(data.telegramText);
  else if (data.type === 'task_deadline') text = `⏰ Напоминание: «${data.title}» через ${data.notifyBefore ?? 15} мин`;
  else if (data.type === 'habit_reminder') text = `🌱 Привычка: «${data.title}» — не забудь отметить сегодня!`;
  else text = `⏰ Напоминание: ${data.title}`;
  return text.slice(0, MAX_TEXT_LENGTH);
};

/**
 * @param {object} deps
 *   db                       Firestore (Admin) instance
 *   serverTimestamp()        FieldValue.serverTimestamp()
 *   fromMillis(ms)           Timestamp.fromMillis
 *   send(chatId, text)       -> Promise<{ok,status,payload}> (may throw)
 *   isRecipientAllowed(id)   -> boolean   (DEV allow-list; always true in production)
 *   shouldSkip(data)         -> Promise<null | {status, reason}>   (optional: e.g. stale habit)
 *   now()                    -> ms
 *   log(event, fields)
 */
async function processDueReminders(deps) {
  const { db, serverTimestamp, fromMillis, send, isRecipientAllowed } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const startedAt = now();
  const stats = { scanned: 0, sent: 0, retried: 0, failed: 0, cancelled: 0, expired: 0, reclaimed: 0, skipped: 0, claimLost: 0, deferred: 0 };
  const userCache = new Map();

  // ── 1. Reclaim crashed workers (expired lease) ───────────────────────────
  const sendingSnap = await db.collection('reminders').where('status', '==', 'sending').limit(SCAN_LIMIT).get();
  let reclaimed = 0;
  for (const docSnap of sendingSnap.docs) {
    if (reclaimed >= MAX_RECLAIM_PER_RUN) break;
    const d = docSnap.data();
    // Documents left in `sending` by older code carry no lease: judge by updatedAt.
    const leaseEnd = Number.isFinite(toMillis(d.leaseUntil)) ? toMillis(d.leaseUntil)
      : (Number.isFinite(toMillis(d.updatedAt)) ? toMillis(d.updatedAt) + LEASE_MS : 0);
    if (leaseEnd > now()) continue;
    const outcome = await db.runTransaction(async (tx) => {
      const latest = await tx.get(docSnap.ref);
      if (!latest.exists) return null;
      const cur = latest.data();
      if (cur.status !== 'sending') return null;
      const curLeaseEnd = Number.isFinite(toMillis(cur.leaseUntil)) ? toMillis(cur.leaseUntil)
        : (Number.isFinite(toMillis(cur.updatedAt)) ? toMillis(cur.updatedAt) + LEASE_MS : 0);
      if (curLeaseEnd > now()) return null;
      const attempts = (cur.retryCount ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        tx.update(docSnap.ref, { status: 'failed', retryCount: attempts, lastError: 'lease_expired_retries_exhausted', claimId: null, leaseUntil: null, updatedAt: serverTimestamp() });
        return 'failed';
      }
      tx.update(docSnap.ref, {
        status: 'pending', retryCount: attempts, lastError: 'lease_expired', claimId: null, leaseUntil: null,
        scheduledAt: fromMillis(now() + backoffMs(attempts)), updatedAt: serverTimestamp(),
      });
      return 'requeued';
    });
    if (outcome) { reclaimed++; stats.reclaimed++; log('reminder_lease_expired', { id: docSnap.id, outcome }); }
  }

  // ── 2. Select due reminders ──────────────────────────────────────────────
  const pendingSnap = await db.collection('reminders').where('status', '==', 'pending').limit(SCAN_LIMIT).get();
  stats.scanned = pendingSnap.size;
  const ready = [];
  const stale = [];
  for (const docSnap of pendingSnap.docs) {
    const at = toMillis(docSnap.data().scheduledAt);
    if (!Number.isFinite(at)) { stats.skipped++; continue; }
    if (at > now()) { stats.deferred++; continue; }
    if (now() - at > MAX_LATE_MS) stale.push(docSnap); else ready.push({ docSnap, at });
  }
  ready.sort((a, b) => a.at - b.at);

  // ── 3. Expire (never send, never delete) reminders that missed their window ──
  for (const docSnap of stale.slice(0, MAX_EXPIRE_PER_RUN)) {
    const done = await db.runTransaction(async (tx) => {
      const latest = await tx.get(docSnap.ref);
      if (!latest.exists || latest.data().status !== 'pending') return false;
      if (now() - toMillis(latest.data().scheduledAt) <= MAX_LATE_MS) return false;
      tx.update(docSnap.ref, { status: 'expired', lastError: 'missed_window', updatedAt: serverTimestamp() });
      return true;
    });
    if (done) { stats.expired++; log('reminder_expired', { id: docSnap.id }); }
  }

  // ── 4. Deliver ───────────────────────────────────────────────────────────
  let attemptedSends = 0;
  for (const { docSnap } of ready) {
    if (attemptedSends >= MAX_SEND_PER_RUN || now() - startedAt > TIME_BUDGET_MS) { stats.deferred++; continue; }
    let stopBatch = false;
    try {
      const r = await processOne(docSnap.ref);
      if (r === 'claim_lost_before') { continue; }
      attemptedSends++;
      if (r && r.stopBatch) stopBatch = true;
    } catch (error) {
      // Per-reminder isolation: one bad document never aborts the batch.
      log('reminder_internal_error', { id: docSnap.id, errorName: (error && error.name) || 'Error' });
    }
    if (stopBatch) { log('batch_stopped', { reason: 'bot_token_rejected' }); break; }
  }
  return stats;

  async function ownerChatId(userId) {
    if (userCache.has(userId)) return userCache.get(userId);
    const snap = await db.collection('users').doc(userId).get();
    const d = snap.exists ? snap.data() : null;
    const chat = d ? (d.chatId ?? d.telegramId ?? null) : null;
    userCache.set(userId, chat);
    return chat;
  }

  async function finish(ref, claimId, patch) {
    return db.runTransaction(async (tx) => {
      const latest = await tx.get(ref);
      if (!latest.exists) return false;
      const cur = latest.data();
      // Only the worker that still owns the lease may write the outcome.
      if (cur.status !== 'sending' || cur.claimId !== claimId) return false;
      tx.update(ref, { ...patch, claimId: null, leaseUntil: null, updatedAt: serverTimestamp() });
      return true;
    });
  }

  async function processOne(ref) {
    const claimId = crypto.randomBytes(8).toString('hex');
    const claimed = await db.runTransaction(async (tx) => {
      const latest = await tx.get(ref);
      if (!latest.exists) return null;
      const cur = latest.data();
      if (cur.status !== 'pending') return null;
      const at = toMillis(cur.scheduledAt);
      if (!Number.isFinite(at) || at > now() || now() - at > MAX_LATE_MS) return null;
      tx.update(ref, { status: 'sending', claimId, leaseUntil: fromMillis(now() + LEASE_MS), updatedAt: serverTimestamp() });
      return cur;
    });
    if (!claimed) return 'claim_lost_before';

    const id = ref.id;
    const settle = async (patch, counter, event, fields) => {
      const ok = await finish(ref, claimId, patch);
      if (ok) { stats[counter]++; log(event, { id, ...fields }); } else { stats.claimLost++; log('reminder_claim_lost', { id }); }
      return ok;
    };

    // Owner / recipient checks: the chat id stored on the document is client-writable,
    // so it is only trusted when it equals the chat id of the owning user.
    if (typeof claimed.userId !== 'string' || !claimed.userId) {
      await settle({ status: 'failed', lastError: 'no_owner' }, 'failed', 'reminder_failed', { code: 'no_owner' });
      return { done: true };
    }
    if (!validChatId(claimed.chatId)) {
      await settle({ status: 'failed', lastError: 'invalid_chat_id' }, 'failed', 'reminder_failed', { code: 'invalid_chat_id' });
      return { done: true };
    }
    const owner = await ownerChatId(claimed.userId);
    if (owner === null || String(owner) !== String(claimed.chatId)) {
      await settle({ status: 'failed', lastError: 'recipient_mismatch' }, 'failed', 'reminder_failed', { code: 'recipient_mismatch' });
      return { done: true };
    }
    if (!isRecipientAllowed(claimed.chatId)) {
      await settle({ status: 'failed', lastError: 'recipient_not_allowed' }, 'failed', 'reminder_failed', { code: 'recipient_not_allowed' });
      return { done: true };
    }
    if (deps.shouldSkip) {
      let skip = null;
      try { skip = await deps.shouldSkip(claimed); } catch { skip = null; /* cannot confirm: send */ }
      if (skip) {
        await settle({ status: skip.status || 'cancelled', lastError: skip.reason }, 'cancelled', 'reminder_cancelled', { code: skip.reason });
        return { done: true };
      }
    }

    let verdict;
    try {
      verdict = classifySendResult(await send(String(claimed.chatId), reminderText(claimed)));
    } catch (error) {
      verdict = classifyThrown(error);
    }

    if (verdict.kind === 'sent') {
      await settle({ status: 'sent', notifiedAt: serverTimestamp(), sentAt: serverTimestamp(), lastError: null }, 'sent', 'reminder_sent', {});
      return { done: true };
    }
    if (verdict.kind === 'terminal') {
      await settle({ status: 'failed', lastError: verdict.code, lastErrorDetail: verdict.detail || null }, 'failed', 'reminder_failed', { code: verdict.code });
      return { done: true };
    }
    const failures = (claimed.retryCount ?? 0) + 1;
    if (failures >= MAX_ATTEMPTS) {
      await settle({ status: 'failed', retryCount: failures, lastError: 'retries_exhausted', lastErrorDetail: verdict.code }, 'failed', 'reminder_failed', { code: 'retries_exhausted', last: verdict.code });
      return { done: true, stopBatch: verdict.stopBatch };
    }
    const delay = Math.max(backoffMs(failures), verdict.retryAfterMs || 0);
    await settle({
      status: 'pending', retryCount: failures, lastError: verdict.code, lastErrorDetail: verdict.detail || null,
      scheduledAt: fromMillis(now() + delay),
    }, 'retried', 'reminder_retry', { code: verdict.code, attempt: failures, delayMs: delay });
    return { done: true, stopBatch: verdict.stopBatch };
  }
}

module.exports = {
  processDueReminders, classifySendResult, classifyThrown, backoffMs, toMillis, reminderText,
  LEASE_MS, MAX_ATTEMPTS, MAX_LATE_MS, SCAN_LIMIT, MAX_SEND_PER_RUN, TIME_BUDGET_MS,
};
