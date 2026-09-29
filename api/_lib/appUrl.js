'use strict';

/**
 * Centralized production app URL.
 *
 * Single source of truth for the canonical public origin used in payment
 * return URLs, Telegram deep links, TonConnect fallback, etc. A future
 * domain change only requires updating REACT_APP_URL in Vercel env vars
 * (Production) and redeploying — no repo-wide search/replace needed.
 *
 * Defaults to the canonical production domain (enma.su, migrated from
 * enma-silk.vercel.app on 2026-09-29) so this stays correct even when
 * REACT_APP_URL isn't set locally (e.g. one-off scripts).
 */
const APP_URL = (process.env.REACT_APP_URL || 'https://enma.su').replace(/\/+$/, '');

module.exports = { APP_URL };
