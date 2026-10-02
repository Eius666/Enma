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

// Raw comma-separated segments, trimmed, empties dropped — BEFORE numeric
// filtering. Exposed separately from canaryIds() only so canaryDiagnostics()
// can tell "configured but malformed" (segments exist, none are valid)
// apart from "not configured at all" (no segments at all), without ever
// touching or returning the segments' actual content.
function rawSegments() {
  const raw = process.env.STARS_CANARY_TELEGRAM_IDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Only numeric ids are accepted — a username or anything non-numeric is
// silently dropped rather than guessed at or partially matched.
function canaryIds() {
  const ids = new Set();
  for (const seg of rawSegments()) {
    if (/^\d+$/.test(seg)) ids.add(Number(seg));
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

// Safe runtime diagnostics for STARS_CANARY_TELEGRAM_IDS — NEVER returns the
// variable's raw value or the list of ids it contains, only shape/counts, so
// it can be surfaced all the way to an API response without leaking anything.
function canaryDiagnostics() {
  const segments = rawSegments();
  const valid = canaryIds();
  return {
    envPresent: !!process.env.STARS_CANARY_TELEGRAM_IDS,
    entriesCountRaw: segments.length,
    entriesCountValid: valid.size,
    // true only when every comma-separated segment parsed as a clean
    // integer — false means at least one entry has stray characters
    // (quotes, brackets, spaces inside the number, a username, etc.)
    allEntriesNumeric: segments.length > 0 && segments.length === valid.size,
  };
}

// Whether a specific (already-verified) telegramUserId is in the allowlist —
// safe to return as a boolean (never the full list) because it only ever
// reflects the SAME id the caller already authenticated as.
function isInCanary(telegramUserId) {
  if (!telegramUserId) return false;
  return canaryIds().has(Number(telegramUserId));
}

module.exports = {
  canaryIds, isCanaryConfigured, isStarsEnabledForUser, canaryDiagnostics, isInCanary,
};
