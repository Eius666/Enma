import {initializeApp} from 'firebase-admin/app';
import {FieldValue, getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {logger} from 'firebase-functions';
import {computeHabitOccurrence, HabitScheduleInput} from './habitSchedule';

initializeApp();

const db = getFirestore();
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_BATCH = 200;
const CONCURRENCY = 5;
const DEFAULT_TZ = 'Europe/Warsaw'; // same fallback as api/_lib/tools.js's getUserTimezone

const computeBackoffSeconds = (retryCount: number) => {
  const next = Math.min(60 * Math.pow(2, retryCount), 3600);
  return Math.max(next, 60);
};

const sendTelegramMessage = async (
  token: string,
  chatId: string | number,
  text: string
) => {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {response, payload};
};

/**
 * Every real producer of a `reminders` doc (api/_lib/tools.js's
 * createReminder/createTask, the legacy client-side habit scheduler in
 * src/App.tsx, and materializeHabitReminders below) already writes a
 * complete, final, type-specific `telegramText`. Only a caller that sets
 * nothing but a bare `title` falls back to a generic wrapper.
 */
const resolveMessageText = (data: {text?: string; telegramText?: string; title?: string}) => {
  if (data.telegramText) return data.telegramText;
  if (data.text) return `⏰ Напоминание:\n${data.text}`;
  return `⏰ Напоминание:\n${data.title ?? ''}`;
};

const claimReminder = async (
  ref: FirebaseFirestore.DocumentReference,
  now: Timestamp
) => {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as {status?: string};
    if (data.status !== 'pending') return null;

    // Claim in transaction to prevent double send.
    tx.update(ref, {
      status: 'sending',
      updatedAt: now
    });

    return snap.data();
  });
};

const processWithConcurrency = async <T>(
  items: T[],
  handler: (item: T) => Promise<void>
) => {
  const queue = [...items];
  const workers = Array.from({length: CONCURRENCY}).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      await handler(item);
    }
  });
  await Promise.all(workers);
};

export const sendDueReminders = onSchedule(
  {
    schedule: 'every 1 minutes',
  },
  async () => {
    const now = Timestamp.now();
    const token = process.env.BOT_TOKEN;
    if (!token) {
      logger.error('BOT_TOKEN env var is not set');
      return;
    }

    const snapshot = await db
      .collection('reminders')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .orderBy('scheduledAt', 'asc')
      .limit(MAX_BATCH)
      .get();

    if (snapshot.empty) {
      logger.info('No reminders to send.');
      return;
    }

    await processWithConcurrency(snapshot.docs, async docSnap => {
      const ref = docSnap.ref;
      const claimed = await claimReminder(ref, now);
      if (!claimed) return;

      const data = claimed as {
        chatId: string | number;
        text?: string;
        telegramText?: string;
        title?: string;
        retryCount?: number;
      };

      const retryCount = data.retryCount ?? 0;
      const messageText = resolveMessageText(data);

      logger.info('habit_notification_claimed', {
        reminderId: ref.id,
        type: (claimed as {type?: string}).type ?? 'generic',
      });

      try {
        const {response, payload} = await sendTelegramMessage(
          token,
          data.chatId,
          messageText
        );

        if (response.ok && (payload.ok as boolean | undefined)) {
          await ref.update({
            status: 'sent',
            sentAt: now,
            updatedAt: now,
            lastError: FieldValue.delete()
          });
          logger.info('habit_notification_sent', {reminderId: ref.id});
          return;
        }

        const status = (payload.error_code as number | undefined) ?? response.status;
        const description =
          (payload.description as string | undefined) ?? 'Telegram send failed';

        if (status === 400 || status === 403) {
          // Chat not found or bot blocked: mark failed.
          await ref.update({
            status: 'failed',
            updatedAt: now,
            lastError: description
          });
          logger.warn('habit_notification_failed', {reminderId: ref.id, status, terminal: true});
          return;
        }

        // Retry with backoff for 429/5xx/unknown.
        const backoffSeconds = computeBackoffSeconds(retryCount + 1);
        logger.warn('habit_notification_retry', {reminderId: ref.id, status, retryCount: retryCount + 1, backoffSeconds});
        await ref.update({
          status: 'pending',
          retryCount: retryCount + 1,
          scheduledAt: Timestamp.fromMillis(now.toMillis() + backoffSeconds * 1000),
          updatedAt: now,
          lastError: description
        });
      } catch (error) {
        // Network or unexpected error: retry with backoff.
        const backoffSeconds = computeBackoffSeconds(retryCount + 1);
        logger.warn('habit_notification_retry', {
          reminderId: ref.id,
          retryCount: retryCount + 1,
          backoffSeconds,
          reason: 'exception',
        });
        await ref.update({
          status: 'pending',
          retryCount: retryCount + 1,
          scheduledAt: Timestamp.fromMillis(now.toMillis() + backoffSeconds * 1000),
          updatedAt: now,
          lastError: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }
);

// ── Habit reminder materialization ──────────────────────────────────────────
//
// Recurring habits (daily or specific weekdays) do NOT by themselves put
// anything into `reminders` — that collection only ever holds concrete,
// one-shot occurrences. Previously the ONLY code that turned a habit's
// reminderTime into a `reminders` doc was a client-side effect in
// src/App.tsx, which only ran while the Mini App happened to be open that
// day, before the reminder time. A user who didn't open the app that day
// got no reminder at all, however correctly `sendDueReminders` above was
// working — it had nothing to deliver.
//
// This job closes that gap server-side: every 15 minutes, for every active
// habit with a reminder time, it ensures *today's* occurrence (in the
// user's own timezone) exists in `reminders` with status 'pending', then
// leaves delivery entirely to the existing sendDueReminders pipeline above.
// It shares that collection's claim/retry/dedup logic and its docId scheme
// with the legacy client-side scheduler (`habit-${habitId}-${dateKey}`), so
// the two paths can never create a duplicate reminder for the same habit on
// the same day — whichever runs first wins, and the other is a no-op.

const HABITS_SCAN_LIMIT = 1000;

interface UserContact {
  chatId: string | number;
  timezone: string;
}

const getUserContact = async (
  userId: string,
  cache: Map<string, UserContact | null>
): Promise<UserContact | null> => {
  if (cache.has(userId)) return cache.get(userId) ?? null;

  const snap = await db.collection('users').doc(userId).get();
  const data = snap.exists ? (snap.data() as {chatId?: string | number; timezone?: string}) : undefined;

  // No chatId → user hasn't linked Telegram yet. Not an error: just nothing
  // to deliver to. (Mirrors api/_lib/tools.js's getUserTimezone fallback.)
  if (!data?.chatId) {
    cache.set(userId, null);
    return null;
  }

  const timezone = (typeof data.timezone === 'string' && data.timezone) ? data.timezone : DEFAULT_TZ;
  const contact: UserContact = {chatId: data.chatId, timezone};
  cache.set(userId, contact);
  return contact;
};

export const materializeHabitReminders = onSchedule(
  {schedule: 'every 15 minutes'},
  async () => {
    const now     = Timestamp.now();
    const nowDate = now.toDate();

    const snapshot = await db.collection('habits').limit(HABITS_SCAN_LIMIT).get();
    if (snapshot.size >= HABITS_SCAN_LIMIT) {
      logger.warn('materializeHabitReminders: hit HABITS_SCAN_LIMIT — some habits may be skipped this run', {
        limit: HABITS_SCAN_LIMIT,
      });
    }

    type HabitDoc = {
      userId?: string;
      title?: string;
      repeatType?: 'daily' | 'custom';
      repeatDays?: number[];
      reminderTime?: string | null;
      archived?: boolean;
    };

    // In-memory filter rather than a Firestore `where('archived','==',false)`
    // query: an equality filter would silently exclude any legacy habit doc
    // that predates the `archived` field instead of treating it as active.
    const candidates = snapshot.docs.filter(d => {
      const h = d.data() as HabitDoc;
      return !h.archived && !!h.reminderTime;
    });

    if (candidates.length === 0) {
      logger.info('materializeHabitReminders: no active habits with a reminder time.');
      return;
    }

    const contactCache = new Map<string, UserContact | null>();
    let created = 0, updated = 0, skippedNoContact = 0, skippedNotDueToday = 0;

    await processWithConcurrency(candidates, async docSnap => {
      const habitId = docSnap.id;
      const h        = docSnap.data() as HabitDoc;
      if (!h.userId) return;

      const contact = await getUserContact(h.userId, contactCache);
      if (!contact) {
        skippedNoContact++;
        return;
      }

      const habitInput: HabitScheduleInput = {
        repeatType:   h.repeatType === 'custom' ? 'custom' : 'daily',
        repeatDays:   h.repeatDays,
        reminderTime: h.reminderTime,
        archived:     h.archived,
      };
      const occurrence = computeHabitOccurrence(habitId, habitInput, contact.timezone, nowDate);
      if (!occurrence) {
        skippedNotDueToday++;
        return;
      }

      const title         = h.title ?? '';
      const telegramText  = `🌱 Привычка: «${title}» — не забудь отметить сегодня!`;
      const ref            = db.collection('reminders').doc(occurrence.docId);
      const scheduledAtTs  = Timestamp.fromDate(occurrence.scheduledAt);

      try {
        // Atomic create-if-absent: fails with ALREADY_EXISTS (code 6) rather
        // than silently overwriting a reminder another path already owns.
        await ref.create({
          userId:      h.userId,
          chatId:      contact.chatId,
          type:        'habit_reminder',
          habitId,
          title,
          scheduledAt: scheduledAtTs,
          status:      'pending',
          telegramText,
          date:        occurrence.dateKey,
          source:      'habit-materializer',
          createdAt:   now,
          updatedAt:   now,
        });
        created++;
        logger.info('habit_notification_due', {reminderId: occurrence.docId, habitId});
      } catch (err) {
        const code = (err as {code?: number}).code;
        if (code !== 6) {
          logger.error('materializeHabitReminders: unexpected create error', {
            habitId,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        // Occurrence already exists (this job's earlier run, or the legacy
        // client-side scheduler). If it's already sending/sent/failed, it's
        // already been handled for today — never touch it. If it's still
        // pending, keep it in sync with the habit's CURRENT reminderTime and
        // title (PHASE 6: "время изменено → использовать новое расписание").
        const existing     = await ref.get();
        const existingData = existing.data() as {status?: string; scheduledAt?: Timestamp; title?: string} | undefined;
        if (existingData?.status !== 'pending') return;

        const sameTime  = existingData.scheduledAt?.toMillis() === scheduledAtTs.toMillis();
        const sameTitle = existingData.title === title;
        if (sameTime && sameTitle) return;

        await ref.update({title, telegramText, scheduledAt: scheduledAtTs, updatedAt: now});
        updated++;
      }
    });

    logger.info('materializeHabitReminders: run complete', {
      habitsScanned:       candidates.length,
      created,
      updated,
      skippedNoContact,
      skippedNotDueToday,
    });
  }
);
