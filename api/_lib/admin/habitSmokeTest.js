'use strict';

// Admin: habit-notification production smoke test (TEMPORARY — remove once
// the fix in materializeHabitReminders/sendDueReminders/api/telegram/cron.js
// is confirmed delivering in production; see the pre-deploy review report).
// POST /api/ai/adminHabitSmokeTestCreate | adminHabitSmokeTestStatus |
// adminHabitSmokeTestDelete. Built by the api/ai router (see api/ai/[action].js).
//
// The target UID is hardcoded, never taken from the request body, by
// design — this can structurally never touch any other user's data even
// if the admin key were misused.

const HABIT_SMOKE_TEST_UID = '2MhVQ2hZD0cgDcYzxlHzhumml9l1';
const HABIT_SMOKE_TEST_ID  = 'enma-smoke-test-habit';

function _smokeTestLocalTimeAfterMinutes(timezone, minutesFromNow) {
  const target = new Date(Date.now() + minutesFromNow * 60000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(target);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const hh = String(parseInt(p.hour, 10) % 24).padStart(2, '0');
  return `${hh}:${p.minute}`;
}

function createHabitSmokeTestHandlers(ctx) {
  const { db, admin, requireAdmin } = ctx;

  async function handleAdminHabitSmokeTestCreate(req, res) {
    if (!requireAdmin(req, res)) return;
    const { getUserTimezone } = require('../tools');

    const uid = HABIT_SMOKE_TEST_UID;
    const habitId = HABIT_SMOKE_TEST_ID;
    const requested = Number(req.body?.minutesFromNow);
    const minutesFromNow = Number.isFinite(requested) ? Math.min(30, Math.max(15, requested)) : 22;

    const timezone = await getUserTimezone(uid);
    const reminderTime = _smokeTestLocalTimeAfterMinutes(timezone, minutesFromNow);

    await db.collection('habits').doc(habitId).set({
      id: habitId,
      userId: uid,
      title: 'ENMA smoke test — safe to delete',
      description: 'Temporary smoke-test habit for the habit-notification pre-deploy review.',
      color: '#7B68EE',
      repeatType: 'daily',
      repeatDays: [],
      reminderTime,
      completedDates: [],
      archived: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      ok: true,
      habitId,
      timezone,
      reminderTimeLocal: reminderTime,
      minutesFromNow,
      nowUtc: new Date().toISOString(),
    });
  }

  async function handleAdminHabitSmokeTestStatus(req, res) {
    if (!requireAdmin(req, res)) return;

    const habitId = HABIT_SMOKE_TEST_ID;
    const habitSnap = await db.collection('habits').doc(habitId).get();

    // Doc id scheme is habit-<habitId>-<dateKey as the materializer resolved
    // it in the user's own timezone> — query by habitId rather than guessing it.
    const remSnap = await db.collection('reminders').where('habitId', '==', habitId).get();
    const reminders = remSnap.docs.map(d => {
      const r = d.data();
      return {
        id:          d.id,
        status:      r.status ?? null,
        scheduledAt: r.scheduledAt?.toDate?.()?.toISOString() ?? null,
        retryCount:  r.retryCount ?? 0,
        sentAt:      r.sentAt?.toDate?.()?.toISOString() ?? null,
        lastError:   r.lastError ?? null,
        source:      r.source ?? null,
      };
    });

    return res.status(200).json({
      ok: true,
      habitExists:       habitSnap.exists,
      habitArchived:      habitSnap.exists ? !!habitSnap.data().archived : null,
      habitReminderTime:  habitSnap.exists ? habitSnap.data().reminderTime : null,
      nowUtc:             new Date().toISOString(),
      reminders,
    });
  }

  async function handleAdminHabitSmokeTestDelete(req, res) {
    if (!requireAdmin(req, res)) return;
    if (req.body?.confirm !== 'DELETE_SMOKE_TEST_HABIT') {
      return res.status(400).json({ ok: false, error: 'confirmation_required' });
    }

    const habitId = HABIT_SMOKE_TEST_ID;
    await db.collection('habits').doc(habitId).delete();

    const remSnap = await db.collection('reminders').where('habitId', '==', habitId).get();
    if (!remSnap.empty) {
      const batch = db.batch();
      remSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    return res.status(200).json({ ok: true, deletedHabitId: habitId, deletedReminders: remSnap.size });
  }

  return { handleAdminHabitSmokeTestCreate, handleAdminHabitSmokeTestStatus, handleAdminHabitSmokeTestDelete };
}

module.exports = { createHabitSmokeTestHandlers };
