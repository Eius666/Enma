'use strict';

// Profile tools of the Telegram assistant: set_timezone, set_banks, get_banks.
// Built by api/_lib/tools.js with its dependencies injected.

function createProfileTools(ctx) {
  const { db, isValidTimezone, getUtcOffsetStr } = ctx;

  async function setTimezone(args, userId) {
    const { timezone } = args;
    if (!isValidTimezone(timezone)) {
      return { ok: false, error: `Неверный часовой пояс: «${timezone}». Пример: Europe/Warsaw` };
    }
    await db.collection('users').doc(userId).update({ timezone });
    const offset = getUtcOffsetStr(timezone);
    return { ok: true, message: `✅ Часовой пояс обновлён: ${timezone} (${offset})` };
  }

  async function setBanks(args, userId) {
    const { banks } = args;
    if (!Array.isArray(banks)) return { ok: false, error: 'banks должен быть массивом' };
    await db.collection('users').doc(userId).update({ banks });
    if (!banks.length) return { ok: true, message: '✅ Список банков очищен.' };
    return { ok: true, message: `✅ Банки сохранены:\n${banks.map(b => `• ${b}`).join('\n')}` };
  }

  async function getBanks(userId) {
    const doc   = await db.collection('users').doc(userId).get();
    const banks = doc.exists ? (doc.data()?.banks || []) : [];
    if (!banks.length) return { ok: true, message: 'Банки не настроены. Добавь: «Мои банки: Тинькофф, Сбербанк, Наличные»', banks: [] };
    return { ok: true, message: `🏦 Твои банки:\n${banks.map(b => `• ${b}`).join('\n')}`, banks };
  }

  return { setTimezone, setBanks, getBanks };
}

module.exports = { createProfileTools };
