'use strict';

// Automation tools of the Telegram assistant: create_automation,
// list_automations, delete_automation, pause_automation. The documents they
// write are run by api/telegram/cron.js. Built by api/_lib/tools.js with its
// dependencies (including the scheduling helpers) injected.

function createAutomationTools(ctx) {
  const { db, admin, createId, DEFAULT_TZ, getUtcOffsetStr, calculateFirstRun, formatScheduleRu } = ctx;

  async function createAutomation(args, userId, chatId, timezone) {
    const { name, message_text, schedule_type, time, days_of_week, day_of_month } = args;
    const tz = timezone || DEFAULT_TZ;

    if (schedule_type === 'weekly' && (!days_of_week || !days_of_week.length)) {
      return { ok: false, error: 'Для weekly расписания укажи days_of_week (1=Пн, 7=Вс)' };
    }
    if (schedule_type === 'monthly' && !day_of_month) {
      return { ok: false, error: 'Для monthly расписания укажи day_of_month (1-31)' };
    }

    const scheduleData = {
      time,
      daysOfWeek:  schedule_type === 'weekly'  ? (days_of_week || []) : [],
      dayOfMonth:  schedule_type === 'monthly' ? (day_of_month || null) : null,
    };

    const nextRunAt = calculateFirstRun(schedule_type, scheduleData, tz);

    const id = createId();
    await db.collection('automations').doc(id).set({
      userId, chatId, name, messageText: message_text,
      scheduleType: schedule_type, scheduleData,
      nextRunAt:  admin.firestore.Timestamp.fromDate(nextRunAt),
      lastRunAt:  null,
      status:     'active',
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    const offset = getUtcOffsetStr(tz);
    const nextStr = nextRunAt.toLocaleString('ru-RU', {
      timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    const schedStr = formatScheduleRu(schedule_type, scheduleData);

    return {
      ok: true,
      message: `✅ Автоматизация «${name}» создана.\nРасписание: ${schedStr}\nПервый запуск: ${nextStr} (${offset})\nID: ${id}`,
    };
  }

  async function listAutomations(userId, timezone) {
    const tz = timezone || DEFAULT_TZ;

    const snap = await db.collection('automations')
      .where('userId',  '==', userId)
      .where('status',  '==', 'active')
      .orderBy('nextRunAt', 'asc')
      .limit(20)
      .get();

    if (snap.empty) return { ok: true, message: 'У вас нет активных автоматизаций.' };

    const offset = getUtcOffsetStr(tz);
    const lines  = snap.docs.map(d => {
      const a       = d.data();
      const nextTs  = a.nextRunAt?.toDate?.();
      const nextStr = nextTs ? nextTs.toLocaleString('ru-RU', {
        timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      }) : '—';
      const schedStr = formatScheduleRu(a.scheduleType, a.scheduleData || {});
      return `🔁 ${a.name}\n   ${schedStr} | след: ${nextStr} (${offset})\n   ID: ${d.id}`;
    });

    return { ok: true, message: `⚙️ Автоматизации:\n\n${lines.join('\n\n')}` };
  }

  async function deleteAutomation(args, userId) {
    const { automation_id } = args;
    const ref  = db.collection('automations').doc(automation_id);
    const snap = await ref.get();

    if (!snap.exists || snap.data().userId !== userId) {
      return { ok: false, error: 'Автоматизация не найдена' };
    }
    await ref.update({ status: 'deleted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, message: `✅ Автоматизация «${snap.data().name}» удалена` };
  }

  async function pauseAutomation(args, userId, timezone) {
    const { automation_id, action } = args;
    const tz  = timezone || DEFAULT_TZ;
    const ref  = db.collection('automations').doc(automation_id);
    const snap = await ref.get();

    if (!snap.exists || snap.data().userId !== userId) {
      return { ok: false, error: 'Автоматизация не найдена' };
    }

    const a = snap.data();
    if (action === 'pause') {
      await ref.update({ status: 'paused', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ok: true, message: `⏸ Автоматизация «${a.name}» приостановлена` };
    }

    if (action === 'resume') {
      const nextRunAt = calculateFirstRun(a.scheduleType, a.scheduleData || {}, tz);
      await ref.update({
        status:    'active',
        nextRunAt: admin.firestore.Timestamp.fromDate(nextRunAt),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const nextStr = nextRunAt.toLocaleString('ru-RU', {
        timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      });
      return { ok: true, message: `▶️ Автоматизация «${a.name}» возобновлена. Следующий запуск: ${nextStr}` };
    }

    return { ok: false, error: 'action должен быть pause или resume' };
  }

  return { createAutomation, listAutomations, deleteAutomation, pauseAutomation };
}

module.exports = { createAutomationTools };
