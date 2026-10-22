'use strict';

// POST /api/ai/entityCreate — creates a task, habit, note or transaction for
// the verified user (the userId in the body is never trusted).
//
// Built by the api/ai router with its dependencies injected (see
// api/ai/[action].js), so this module holds no Firebase or module state.

function createEntityHandlers(ctx) {
  const {
    db, admin, requireAuth,
    createEntityInFirestore, ENTITY_COLLECTION_MAP,
    createFinancialTransaction, TransactionValidationError, FxUnavailableError,
    resolveReminderSchedule,
  } = ctx;

  // ENMA notes-durability audit: ENTITY_COLLECTION_MAP/FREE_ENTITY_CONFIG used
  // to be duplicated in the router AND in api/_lib/entities/createEntity.js,
  // with the entity handler reimplementing the free-tier limit check inline
  // instead of calling createEntityInFirestore — the two copies had already
  // drifted (that one never decremented/recomputed on delete, which is the
  // root cause of "лимит заметок достигнут, но все заметки исчезли"; see
  // createEntity.js's FREE_ENTITY_CONFIG comment). Now imported from the one
  // real implementation instead of redefined here.

  async function handleEntityCreate(req, res) {
    const verifiedUid = await requireAuth(req, res);
    if (!verifiedUid) return;

    const { entityType, data, docId, timeZone: clientTimeZone } = req.body ?? {};
    // userId from body is deliberately ignored — verifiedUid from token is used
    const userId = verifiedUid;

    if (!entityType || !data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Missing entityType or data' });
    }

    const collection = ENTITY_COLLECTION_MAP[entityType];
    if (!collection) {
      return res.status(400).json({ error: `Unknown entityType: ${entityType}` });
    }

    if (entityType === 'transaction') {
      return createTransactionEntity(res, userId, docId, data);
    }

    try {
      // Single implementation of the free-tier limit check (see
      // createEntity.js for why the previous inline copy was the actual
      // root cause of "лимит заметок достигнут, но все заметки исчезли" —
      // this one derives `used` from a live count of the user's own
      // documents for habit/note instead of a counter nothing ever
      // decrements).
      const created = await createEntityInFirestore(userId, entityType, data, docId);
      if (!created.ok) {
        return res.status(429).json({
          error: 'Limit exceeded', code: 'free_limit',
          limit: created.limit, current: created.current,
        });
      }
      const entityId = created.id;

      let reminder = 'not_requested';
      if (entityType === 'task' && data.time && data.date) {
        reminder = await scheduleTaskReminder(userId, entityId, data, clientTimeZone);
      }

      return res.status(200).json({ ok: true, id: entityId, reminder });
    } catch (err) {
      console.error('[ai/entityCreate] error:', err.message);
      return res.status(500).json({ error: 'Failed to create entity' });
    }
  }

  // Transactions: money fields are decided server-side by the shared service
  // (client-sent rubAmount / fx / schemaVersion are ignored — never trusted).
  async function createTransactionEntity(res, userId, docId, data) {
    try {
      const created = await createFinancialTransaction({
        uid: userId,
        docId: docId ? String(docId) : undefined,
        type: data.type,
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        date: typeof data.date === 'string' ? data.date : undefined,
        categoryId: data.categoryId,
        category: data.category,
        bank: data.bank,
        goalId: data.goalId,
        source: 'web-app',
      }, {
        persist: (uid, doc, id) => createEntityInFirestore(uid, 'transaction', doc, id),
      });
      if (!created.ok) {
        return res.status(429).json({
          error: 'Limit exceeded', code: 'free_limit',
          limit: created.limit, current: created.current,
        });
      }
      const t = created.transaction;
      return res.status(200).json({
        ok: true, id: created.id,
        transaction: { amount: t.amount, currency: t.currency, rubAmount: t.rubAmount, fx: t.fx, schemaVersion: t.schemaVersion },
      });
    } catch (err) {
      if (err instanceof FxUnavailableError) {
        return res.status(503).json({ error: 'FX unavailable', code: 'fx_unavailable', currency: err.currency });
      }
      if (err instanceof TransactionValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error('[ai/entityCreate] transaction error:', err.message);
      return res.status(500).json({ error: 'Failed to create entity' });
    }
  }

  // Create a reminder in Firestore when a task has a specific time set.
  // The scheduler (api/telegram/cron.js or Firebase sendDueReminders) delivers it.
  // The time zone is the one the user typed the time in (sent by the client) or
  // the one stored on the user — it is never guessed. The document id is
  // derived from the task so a repeated request cannot create a second reminder.
  // Never throws: the task itself is already created, the outcome is returned.
  async function scheduleTaskReminder(userId, entityId, data, clientTimeZone) {
    let reminder;
    try {
      const userSnap = await db.collection('users').doc(userId).get();
      const ud       = userSnap.exists ? userSnap.data() : {};
      const chatId   = ud.chatId || ud.telegramId;
      if (!chatId) {
        reminder = 'no_telegram_link';
      } else {
        const schedule = resolveReminderSchedule({
          date: data.date, time: data.time, clientTimeZone, userTimeZone: ud.timezone,
        });
        if (!schedule.ok) {
          reminder = schedule.reason;
        } else {
          try {
            await db.collection('reminders').doc(`task-${entityId}`).create({
              userId,
              chatId,
              title:        data.title || '',
              scheduledAt:  admin.firestore.Timestamp.fromDate(schedule.scheduledAt),
              timezone:     schedule.timeZone,
              status:       'pending',
              retryCount:   0,
              telegramText: `Задача: ${data.title || ''}`,
              taskId:       entityId,
              source:       'web-app',
              createdAt:    admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
            });
            reminder = 'scheduled';
          } catch (createErr) {
            if (createErr && (createErr.code === 6 || /already exists/i.test(createErr.message || ''))) reminder = 'already_scheduled';
            else throw createErr;
          }
        }
      }
      console.log(JSON.stringify({ event: 'entityCreate_reminder', taskId: entityId, result: reminder }));
    } catch (reminderErr) {
      reminder = 'error';
      console.error('[entityCreate] reminder creation failed:', reminderErr.message);
    }
    return reminder;
  }

  return { handleEntityCreate };
}

module.exports = { createEntityHandlers };
