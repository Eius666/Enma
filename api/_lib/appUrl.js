'use strict';

/**
 * Centralized production app URL.
 *
 * Single source of truth for the canonical public origin used in payment
 * return URLs, Telegram deep links, TonConnect fallback, etc. A future
 * domain change only requires updating REACT_APP_URL in Vercel env vars
 * (Production) and redeploying — no repo-wide search/replace needed.
 *
 * Defaults to the current production domain so behavior is unchanged
 * until REACT_APP_URL is explicitly set.
 */
const APP_URL = (process.env.REACT_APP_URL || 'https://enma-silk.vercel.app').replace(/\/+$/, '');

module.exports = { APP_URL };
