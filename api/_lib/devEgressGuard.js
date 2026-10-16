'use strict';

/**
 * DEV egress guard — a single chokepoint for every outbound HTTP call.
 *
 * ENMA_ENV=dev only. In production (ENMA_ENV unset) requiring this module is a
 * no-op and `fetch` is never touched.
 *
 * Why: ~35 call sites talk to api.telegram.org directly, plus Platega, TON and
 * Threads. Instead of patching each, DEV wraps `fetch` once:
 *   - Telegram: the bot token in the URL must belong to DEV_TELEGRAM_BOT_ID;
 *     any method that addresses a chat/user (chat_id, user_id, from_chat_id)
 *     must target an id in DEV_ALLOWED_CHAT_IDS; unknown methods fail closed.
 *   - Platega / TON / Threads: blocked unless explicitly opted in.
 * A blocked call throws EnvIsolationError (fixed code, no values).
 */

const { EnvIsolationError, getEnvName, isChatAllowed } = require('./envIsolation');

// Methods that never address a chat or user.
const NO_CHAT_METHODS = new Set([
  'getMe', 'getFile', 'getWebhookInfo', 'setWebhook', 'answerCallbackQuery',
  'answerPreCheckoutQuery', 'createInvoiceLink', 'getStarTransactions',
  'setMyCommands', 'setChatMenuButton',
]);
const TG_PATH = /^\/(?:file\/)?bot(\d+):[^/]+\/(?:test\/)?([A-Za-z]+)/;
const CHAT_KEYS = ['chat_id', 'user_id', 'from_chat_id'];

const BLOCKED_HOSTS = [
  { match: (h) => h === 'platega.io' || h.endsWith('.platega.io'), optIn: 'DEV_PLATEGA_SANDBOX', code: 'DEV_EGRESS_PLATEGA_BLOCKED' },
  { match: (h) => h === 'toncenter.com' || h.endsWith('.toncenter.com') || h === 'tonapi.io' || h.endsWith('.tonapi.io'), optIn: 'DEV_TON_ENABLED', code: 'DEV_EGRESS_TON_BLOCKED' },
  { match: (h) => h === 'graph.threads.net' || h === 'graph.facebook.com', optIn: 'DEV_SOCIAL_ENABLED', code: 'DEV_EGRESS_SOCIAL_BLOCKED' },
];

function targetsFrom(url, init) {
  const found = {};
  const take = (get) => { for (const k of CHAT_KEYS) { const v = get(k); if (v !== undefined && v !== null && v !== '') found[k] = String(v); } };
  take((k) => url.searchParams.get(k));
  const body = init && init.body;
  if (typeof body === 'string') {
    try { const o = JSON.parse(body); if (o && typeof o === 'object') take((k) => o[k]); }
    catch { try { const p = new URLSearchParams(body); take((k) => p.get(k)); } catch { /* unparseable */ } }
  } else if (body && typeof body.get === 'function') { // FormData / URLSearchParams
    take((k) => body.get(k));
  } else if (body !== undefined && body !== null) {
    return null; // stream / buffer: cannot inspect → caller fails closed
  }
  return found;
}

/** @returns {string|null} error code if the request must be blocked */
function evaluateRequest(rawUrl, init, env = process.env) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return null; } // relative / non-HTTP: not external egress
  const host = url.hostname.toLowerCase();

  for (const b of BLOCKED_HOSTS) {
    if (b.match(host) && String(env[b.optIn] || '').toLowerCase() !== 'true') return b.code;
  }
  if (host !== 'api.telegram.org') return null;

  const m = TG_PATH.exec(url.pathname);
  if (!m) return 'DEV_EGRESS_TELEGRAM_UNPARSEABLE';
  const [, botId, method] = m;
  if (!/^\d+$/.test(env.DEV_TELEGRAM_BOT_ID || '') || botId !== env.DEV_TELEGRAM_BOT_ID) return 'DEV_EGRESS_FOREIGN_BOT';
  if (url.pathname.startsWith('/file/')) return null; // file download for the DEV bot's own files

  const targets = targetsFrom(url, init);
  if (targets === null) return NO_CHAT_METHODS.has(method) ? null : 'DEV_EGRESS_TELEGRAM_BODY_UNINSPECTABLE';
  const keys = Object.keys(targets);
  if (keys.length === 0) return NO_CHAT_METHODS.has(method) ? null : 'DEV_EGRESS_TELEGRAM_NO_TARGET';
  for (const k of keys) if (!isChatAllowed(targets[k], env)) return 'DEV_EGRESS_CHAT_NOT_ALLOWED';
  return null;
}

function createGuardedFetch(realFetch, env = process.env) {
  const guarded = function guardedFetch(input, init) {
    const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
    const code = evaluateRequest(url, init, env);
    if (code) return Promise.reject(new EnvIsolationError(code));
    return realFetch(input, init);
  };
  guarded.__enmaDevGuard = true;
  return guarded;
}

function installEgressGuard(env = process.env) {
  if (getEnvName(env) !== 'dev') return false;
  if (typeof global.fetch !== 'function' || global.fetch.__enmaDevGuard) return false;
  global.fetch = createGuardedFetch(global.fetch, env);
  return true;
}

installEgressGuard(); // no-op unless ENMA_ENV=dev

module.exports = { evaluateRequest, createGuardedFetch, installEgressGuard };
