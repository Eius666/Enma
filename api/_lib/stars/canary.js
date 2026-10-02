'use strict';

// Safe production canary allowlist for the Stars Mini App flow (follow-up
// to the Telegram Stars Audit / Production Readiness work). Lets a specific,
// explicitly-configured set of numeric Telegram user ids see and use Stars
// while STARS_MINIAPP_ENABLED stays false for everyone else.
//
// The Telegram id this checks against must ALWAYS come from a verified
// initData (see api/_lib/verifyWebhookSig.js:verifyInitData) — never from a
// client-supplied body/query parameter. Every caller in this codebase
// already follows that rule; this module itself does no verification, it
// only decides yes/no once given a trusted id.

const { STARS_MINIAPP_ENABLED } = require('./config');

// Only numeric ids are accepted — a username or anything non-numeric is
// silently dropped rather than guessed at or partially matched.
function canaryIds() {
  const raw = process.env.STARS_CANARY_TELEGRAM_IDS || '';
  const ids = new Set();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed && /^\d+$/.test(trimmed)) ids.add(Number(trimmed));
  }
  return ids;
}

function isCanaryConfigured() {
  return canaryIds().size > 0;
}

function isStarsEnabledForUser(telegramUserId) {
  if (STARS_MINIAPP_ENABLED) return true;
  if (!telegramUserId) return false;
  return canaryIds().has(Number(telegramUserId));
}

module.exports = { canaryIds, isCanaryConfigured, isStarsEnabledForUser };
