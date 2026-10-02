'use strict';

// Single source of truth for Telegram Stars pricing + rollout flags.
// See Telegram Stars Audit §4/§10 and the follow-up production-readiness work.

// STAR_PRICE_MONTHLY is the ONLY real Stars price that has ever existed in
// this product — flat, "Pro / 1 month" only, already live before this change
// (api/telegram/webhook.js used to read this same env var directly). We do
// NOT invent prices for premium or yearly Stars plans here: if the business
// wants those, that's a separate pricing decision, not something to infer
// from SBP_PRICES or from the (dead) USD-based frontend calculator.
const STAR_PRICE_MONTHLY = parseInt(process.env.STAR_PRICE_MONTHLY, 10) || 1000;

const STARS_PLANS = Object.freeze({
  pro: Object.freeze({ month: STAR_PRICE_MONTHLY }),
});

function starsPriceFor(plan, period) {
  return STARS_PLANS[plan]?.[period] ?? null;
}

function isValidStarsPlan(plan, period) {
  return starsPriceFor(plan, period) !== null;
}

// ── Rollout feature flags (Telegram Stars Audit §25) ─────────────────────────
// All default OFF so deploying this code changes nothing in production until
// the owner explicitly flips them (via `vercel env add`) after their own
// testing — never set from code.
const STARS_MINIAPP_ENABLED            = process.env.STARS_MINIAPP_ENABLED === 'true';
const LEGACY_STARS_BOT_INVOICE_ENABLED = process.env.LEGACY_STARS_BOT_INVOICE_ENABLED === 'true';
const STARS_RECURRING_ENABLED          = process.env.STARS_RECURRING_ENABLED === 'true';

// 30 days, in seconds — only ever attached to an invoice when
// STARS_RECURRING_ENABLED is true (Telegram Bot API `subscription_period`).
const STARS_SUBSCRIPTION_PERIOD_SECONDS = 2592000;

// How long a Mini App-created payment session stays valid before its invoice
// link is considered stale and pre_checkout_query must reject it.
const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000;

module.exports = {
  STAR_PRICE_MONTHLY,
  STARS_PLANS,
  starsPriceFor,
  isValidStarsPlan,
  STARS_MINIAPP_ENABLED,
  LEGACY_STARS_BOT_INVOICE_ENABLED,
  STARS_RECURRING_ENABLED,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
  PAYMENT_SESSION_TTL_MS,
};
