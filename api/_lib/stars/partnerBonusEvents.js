'use strict';

// Architectural placeholder only (Telegram Stars Audit §21). Nothing in this
// file is called from anywhere yet, and it must stay that way until there's
// a reliable way to tie a native Telegram affiliate commission back to a
// specific Enma partner identity (see reconcile.js's affiliate_user /
// affiliate_chat fields — that linkage is the missing piece today).
//
// Planned collection: `partner_bonus_events`
//
//   affiliatePeer       — Telegram user/chat id the native Affiliate Program
//                          attributes the commission to (from AffiliateInfo)
//   milestone           — e.g. 5 / 15 / 30 (paid users)
//   verifiedPaidUsers   — the count that was actually verified, not claimed
//   rewardType          — e.g. 'stars' | 'rub' | 'none' (undecided)
//   rewardAmount        — undecided — REQUIRES BUSINESS DECISION
//   status              — 'pending' | 'approved' | 'paid'
//   createdAt
//
// This collection intentionally receives NO writes from product code today.

// Config only — read nowhere else yet. Defaults OFF; milestones are
// configurable so the numbers can be discussed without touching code, but no
// reward amount is defined anywhere (deliberately — that's a business
// decision, not a default to invent).
const PARTNER_BONUS_ENABLED = process.env.PARTNER_BONUS_ENABLED === 'true';

const PARTNER_BONUS_MILESTONES = (process.env.PARTNER_BONUS_MILESTONES || '5,15,30')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

module.exports = { PARTNER_BONUS_ENABLED, PARTNER_BONUS_MILESTONES };
