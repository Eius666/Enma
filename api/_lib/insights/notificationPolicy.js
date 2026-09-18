'use strict';

// ── Notification policy — separate layer between event and channel ─────────────
//
// Events exist independent of notifications.
// Each channel has its own eligibility check.
// Notification is never sent from a detector directly.

const { admin, db } = require('../firebaseAdmin');
const { INSIGHTS_CONFIG } = require('./config');

const TELEGRAM_API = 'https://api.telegram.org';

// ── Quiet hours — uses user's local timezone ──────────────────────────────────

function isQuietHours(tz) {
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Europe/Moscow',
      hour: 'numeric', hour12: false,
    }).format(new Date());
    const hour = parseInt(hourStr, 10);
    const { startHour, endHour } = INSIGHTS_CONFIG.quietHours;
    return hour >= startHour || hour < endHour;
  } catch {
    return false; // on TZ parse error, assume not quiet (fail open for notifications)
  }
}

// ── Cooldown check ────────────────────────────────────────────────────────────

function isWithinCooldown(insight) {
  if (!insight.notifiedAt) return false;
  const cfg        = INSIGHTS_CONFIG[insight.type] || {};
  const cooldownMs = cfg.cooldownMs || 24 * 3600 * 1000;
  const notifiedMs = insight.notifiedAt?.toMillis?.() || 0;
  return Date.now() - notifiedMs < cooldownMs;
}

// ── shouldNotifyTelegram ──────────────────────────────────────────────────────

function shouldNotifyTelegram(insight, userTimezone) {
  if (isQuietHours(userTimezone)) return { send: false, reason: 'quiet_hours' };
  if (isWithinCooldown(insight))  return { send: false, reason: 'cooldown' };
  return { send: true };
}

// ── Format insight for Telegram HTML ─────────────────────────────────────────

function formatInsightForTelegram(insight) {
  const icons = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
  const icon  = icons[insight.severity] || '📊';
  const parts = [
    `${icon} <b>${insight.title}</b>`,
    insight.bodyText || '',
  ];
  return parts.filter(Boolean).join('\n');
}

// ── sendTelegramInsight — raw HTTP call ───────────────────────────────────────

async function sendTelegramMessage(token, chatId, text) {
  const resp = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const payload = await resp.json().catch(() => ({}));
  return { ok: resp.ok && payload.ok !== false, status: resp.status };
}

// ── notifyIfEligible — main entry for notification layer ─────────────────────
//
// Checks: chatId exists → quiet hours → cooldown → send
// After send: marks notifiedAt + status='shown' on the insight doc.
// If chatId is null: event is still stored (in-app), Telegram is skipped without error.

async function notifyIfEligible(uid, insight, userDoc, token) {
  const chatId   = userDoc.chatId || userDoc.telegramChatId;
  const timezone = userDoc.timezone || 'Europe/Moscow';

  if (!chatId) {
    return { sent: false, channel: 'in_app_only', reason: 'no_chatId' };
  }

  const policy = shouldNotifyTelegram(insight, timezone);
  if (!policy.send) {
    return { sent: false, channel: 'skipped', reason: policy.reason };
  }

  if (!token) {
    return { sent: false, channel: 'skipped', reason: 'no_token' };
  }

  const text       = formatInsightForTelegram(insight);
  const sendResult = await sendTelegramMessage(token, chatId, text);

  if (!sendResult.ok) {
    return { sent: false, channel: 'telegram', reason: 'send_failed', status: sendResult.status };
  }

  // Mark notified
  await db.collection('users').doc(uid).collection('insights').doc(insight.fingerprint).update({
    notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    status:     'shown',
    updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {}); // non-fatal

  return { sent: true, channel: 'telegram' };
}

module.exports = {
  isQuietHours,
  isWithinCooldown,
  shouldNotifyTelegram,
  notifyIfEligible,
  formatInsightForTelegram,
};
