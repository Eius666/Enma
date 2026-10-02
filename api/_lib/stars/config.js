'use strict';

// Single source of truth for Telegram Stars pricing + rollout flags.
// See Telegram Stars Audit §4/§10 and the follow-up production-readiness work.
//
// PRICING MODEL (corrected — Pro and Premium previously both showed the same
// flat 1000 XTR, which was wrong: they have different real USD prices):
//
//   starsPrice = ceil((usdPrice / TELEGRAM_STAR_REWARD_USD) / 10) * 10
//
// TELEGRAM_STAR_REWARD_USD is Telegram's DEVELOPER reward rate (what a bot
// actually receives per Star after Telegram's own cut) — NOT the retail
// price a user pays to buy Stars, which varies by region/platform/VAT and
// must never be used here. Rounding is always UP to the nearest 10 XTR so a
// plan's Stars price never ends up cheaper than its real USD price.

const TELEGRAM_STAR_REWARD_USD = 0.013;

// Mirrors `PLANS` in src/subscription.ts — the canonical USD price source
// for the whole product (SBP pricing, trial logic, prorated upgrades all
// derive from it too). This backend module can't import frontend TypeScript
// directly, so these numbers are kept in sync by hand; if
// PLANS.pro/premium.monthlyPrice ever changes there, update it here too.
//
// Only `month` is populated — Stars has only ever sold monthly plans (no
// yearly product exists for this rail yet). `PLANS.pro/premium.yearlyPrice`
// exist for SBP/TON/USDT but are deliberately NOT mirrored here: adding a
// yearly Stars price is a product decision, not something to infer just
// because the formula would technically compute one.
const PLAN_USD_PRICES = Object.freeze({
  pro:     Object.freeze({ month: 8 }),
  premium: Object.freeze({ month: 11 }),
});

// Pure rounding rule — ceil to the nearest 10 XTR, never round/floor, so the
// result is always >= the exact USD-equivalent amount of Stars.
function usdToStars(usdPrice) {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
    throw new RangeError(`usdToStars: usdPrice must be a finite number > 0, got ${usdPrice}`);
  }
  const stars = Math.ceil((usdPrice / TELEGRAM_STAR_REWARD_USD) / 10) * 10;
  if (!Number.isFinite(stars) || stars % 10 !== 0) {
    // Should be unreachable given the math above — fail loudly if it ever is.
    throw new RangeError(`usdToStars: computed an invalid Stars amount (${stars}) for usdPrice=${usdPrice}`);
  }
  return stars;
}

// plan/period -> Stars price, computed from the canonical USD price —
// never a separate hardcoded number that could drift from PLAN_USD_PRICES.
function starsPriceFor(plan, period) {
  const usdPrice = PLAN_USD_PRICES[plan]?.[period];
  if (usdPrice === undefined) return null;
  return usdToStars(usdPrice);
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
  TELEGRAM_STAR_REWARD_USD,
  PLAN_USD_PRICES,
  usdToStars,
  starsPriceFor,
  isValidStarsPlan,
  STARS_MINIAPP_ENABLED,
  LEGACY_STARS_BOT_INVOICE_ENABLED,
  STARS_RECURRING_ENABLED,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
  PAYMENT_SESSION_TTL_MS,
};
