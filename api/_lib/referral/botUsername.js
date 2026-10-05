'use strict';

// ── Single source of truth for the bot's @username ───────────────────────────
//
// Every place that builds a t.me link from scratch (consumer ref_CODE links
// in codes.js/commands.js, partner ref_CODE links in partners.js, the
// Settings "share link" in api/ai/[action].js's handleReferralInfo) must
// resolve to the exact same @username, or links silently point at the wrong
// bot (see PARTNER_CTA / REFERRAL_BOT_USERNAME audits — this already
// happened once: the bot was renamed from @EnmaAI_bot to @YourArc_bot and
// several hardcoded fallbacks were never updated).
//
// Deliberately its own tiny module, not re-exported from partners.js: both
// codes.js and partners.js already require each other (partners.js uses
// codes.js's findUserByReferralCode/handleReferralStart), so hanging this
// off either of them would create a circular require.
//
// process.env.TELEGRAM_BOT_USERNAME is the live, authoritative override —
// set in production. The hardcoded fallback only matters if that env var is
// ever unset (e.g. a fresh local/preview environment), and must be kept
// equal to the bot's real @username (verified via Bot API getMe) — see
// api/ai/[action].js's handlePartnerBotInfo, which checks this live.
function botUsername() {
  return process.env.TELEGRAM_BOT_USERNAME || 'YourArc_bot';
}

module.exports = { botUsername };
