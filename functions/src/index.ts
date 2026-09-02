import {initializeApp} from 'firebase-admin/app';
import {FieldValue, getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret} from 'firebase-functions/params';
import {logger} from 'firebase-functions';

initializeApp();

const BOT_TOKEN = defineSecret('BOT_TOKEN');
const db = getFirestore();
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_BATCH = 200;
const CONCURRENCY = 5;

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
      text: `⏰ Напоминание:\n${text}`,
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {response, payload};
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
    secrets: [BOT_TOKEN]
  },
  async () => {
    const now = Timestamp.now();
    const token = BOT_TOKEN.value();

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
      const messageText = data.telegramText ?? data.text ?? data.title ?? '';

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
          return;
        }

        // Retry with backoff for 429/5xx/unknown.
        const backoffSeconds = computeBackoffSeconds(retryCount + 1);
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
