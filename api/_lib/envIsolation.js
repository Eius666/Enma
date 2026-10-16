'use strict';

/**
 * Environment isolation (DEV vs PRODUCTION) — fail closed.
 *
 * ENMA_ENV selects the behaviour:
 *   unset / "production" → unchanged production behaviour (nothing extra is
 *                          enforced except the Vercel-project cross-check).
 *   "dev"                → strict: DEV must never touch production resources.
 *
 * Errors carry fixed codes only — never values taken from env or credentials.
 */

const PROD_FIREBASE_PROJECT_ID = 'enma-4ea29';
// The existing production Vercel project (`enma`). Not a secret: it is an
// identifier. Lets a deployment on ANY OTHER Vercel project refuse to run
// with production Firebase credentials even if ENMA_ENV was forgotten.
const PROD_VERCEL_PROJECT_ID   = 'prj_sfP2tRu4Q7iM1v0RVu9oFFE5gdeX';
const PROD_BOT_USERNAME        = 'YourArc_bot';
const PROD_ORIGINS             = ['https://enma.su', 'https://www.enma.su'];

class EnvIsolationError extends Error {
  constructor(code) {
    super(`ENV_ISOLATION:${code}`);
    this.name = 'EnvIsolationError';
    this.code = code;
  }
}

function getEnvName(env = process.env) {
  const raw = String(env.ENMA_ENV || 'production').trim().toLowerCase();
  if (raw !== 'production' && raw !== 'dev') throw new EnvIsolationError('ENMA_ENV_INVALID');
  return raw;
}

const isTrue = (v) => String(v || '').toLowerCase() === 'true';

function botIdFromToken(token) {
  const m = /^(\d+):/.exec(String(token || ''));
  return m ? m[1] : null;
}

function parseChatIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Server-side check. Called when the Firebase Admin SDK is initialised, so
 * every API route that can reach Firestore passes through it.
 *
 * @param {{ serviceAccountProjectId: string|undefined, env?: object }} opts
 * @returns {{ envName: 'production'|'dev' }}
 */
function assertEnvironmentIsolation({ serviceAccountProjectId, env = process.env } = {}) {
  const envName = getEnvName(env);

  // Independent of ENMA_ENV: production Firebase credentials on a Vercel
  // project other than the production one.
  if (
    serviceAccountProjectId === PROD_FIREBASE_PROJECT_ID &&
    env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== PROD_VERCEL_PROJECT_ID
  ) {
    throw new EnvIsolationError('PROD_FIREBASE_ON_NON_PROD_VERCEL_PROJECT');
  }

  if (envName === 'production') return { envName };

  // ── DEV ────────────────────────────────────────────────────────────────
  if (!serviceAccountProjectId) throw new EnvIsolationError('DEV_FIREBASE_PROJECT_UNKNOWN');
  if (serviceAccountProjectId === PROD_FIREBASE_PROJECT_ID) throw new EnvIsolationError('DEV_USES_PROD_FIREBASE');
  // On Vercel the project id must be known: without it we cannot prove this is
  // not the production project (system env vars may be switched off).
  if (env.VERCEL_ENV && !env.VERCEL_PROJECT_ID) throw new EnvIsolationError('DEV_VERCEL_PROJECT_ID_UNAVAILABLE');
  if (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID === PROD_VERCEL_PROJECT_ID) {
    throw new EnvIsolationError('DEV_ON_PROD_VERCEL_PROJECT');
  }
  // Positive identification: on Vercel the running project must be exactly the
  // declared DEV project (not merely "not production").
  if (env.VERCEL_ENV) {
    if (!env.DEV_VERCEL_PROJECT_ID || env.DEV_VERCEL_PROJECT_ID === PROD_VERCEL_PROJECT_ID) {
      throw new EnvIsolationError('DEV_VERCEL_PROJECT_NOT_DECLARED');
    }
    if (env.VERCEL_PROJECT_ID !== env.DEV_VERCEL_PROJECT_ID) throw new EnvIsolationError('DEV_VERCEL_PROJECT_MISMATCH');
  }
  if (String(env.FIREBASE_STORAGE_BUCKET || '').includes(PROD_FIREBASE_PROJECT_ID)) {
    throw new EnvIsolationError('DEV_USES_PROD_STORAGE_BUCKET');
  }
  if (!env.DEV_FIREBASE_PROJECT_ID || env.DEV_FIREBASE_PROJECT_ID === PROD_FIREBASE_PROJECT_ID) {
    throw new EnvIsolationError('DEV_FIREBASE_PROJECT_NOT_DECLARED');
  }
  if (env.DEV_FIREBASE_PROJECT_ID !== serviceAccountProjectId) {
    throw new EnvIsolationError('DEV_FIREBASE_PROJECT_MISMATCH');
  }

  // Telegram: the token must belong to the explicitly declared DEV bot.
  if (!/^\d+$/.test(env.DEV_TELEGRAM_BOT_ID || '')) throw new EnvIsolationError('DEV_TELEGRAM_BOT_ID_NOT_DECLARED');
  if (env.TELEGRAM_BOT_TOKEN && botIdFromToken(env.TELEGRAM_BOT_TOKEN) !== env.DEV_TELEGRAM_BOT_ID) {
    throw new EnvIsolationError('DEV_BOT_TOKEN_NOT_DEV_BOT');
  }
  // botUsername() falls back to the production bot when this is unset, so it
  // must be declared explicitly in DEV.
  if (!env.TELEGRAM_BOT_USERNAME) throw new EnvIsolationError('DEV_BOT_USERNAME_NOT_DECLARED');
  if (String(env.TELEGRAM_BOT_USERNAME).toLowerCase() === PROD_BOT_USERNAME.toLowerCase()) {
    throw new EnvIsolationError('DEV_USES_PROD_BOT_USERNAME');
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET.length < 16) {
    throw new EnvIsolationError('DEV_WEBHOOK_SECRET_MISSING');
  }
  // Cron routes treat an unset CRON_SECRET as "no auth" (fail-open), so DEV
  // must always define one.
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 16) throw new EnvIsolationError('DEV_CRON_SECRET_MISSING');
  if (parseChatIds(env.DEV_ALLOWED_CHAT_IDS).length === 0) {
    throw new EnvIsolationError('DEV_ALLOWED_CHAT_IDS_MISSING');
  }

  assertClientConfig(env);

  // Payments: no credentials at all unless explicitly opted in (sandbox).
  if ((env.PLATEGA_MERCHANT_ID || env.PLATEGA_SECRET) && !isTrue(env.DEV_PLATEGA_SANDBOX)) {
    throw new EnvIsolationError('DEV_HAS_PLATEGA_CREDENTIALS');
  }
  if ((env.TON_PAYMENT_WALLET || env.TONCENTER_API_KEY) && !isTrue(env.DEV_TON_ENABLED)) {
    throw new EnvIsolationError('DEV_HAS_TON_CREDENTIALS');
  }

  return { envName };
}

/**
 * Client/build-time checks (REACT_APP_*), also run from the prebuild script.
 * Only enforced when ENMA_ENV=dev.
 */
function assertClientConfig(env = process.env) {
  if (getEnvName(env) !== 'dev') return;
  // Fail closed on missing parameters: a DEV build must declare what it targets.
  if (!env.DEV_FIREBASE_PROJECT_ID) throw new EnvIsolationError('DEV_FIREBASE_PROJECT_NOT_DECLARED');
  if (!env.REACT_APP_FIREBASE_PROJECT_ID) throw new EnvIsolationError('DEV_CLIENT_FIREBASE_PROJECT_MISSING');
  if (!env.REACT_APP_URL) throw new EnvIsolationError('DEV_CLIENT_URL_MISSING');
  for (const k of ['REACT_APP_FIREBASE_AUTH_DOMAIN', 'REACT_APP_FIREBASE_STORAGE_BUCKET']) {
    if (String(env[k] || '').includes(PROD_FIREBASE_PROJECT_ID)) throw new EnvIsolationError('DEV_CLIENT_USES_PROD_FIREBASE');
  }
  if (env.REACT_APP_FIREBASE_PROJECT_ID === PROD_FIREBASE_PROJECT_ID) {
    throw new EnvIsolationError('DEV_CLIENT_USES_PROD_FIREBASE');
  }
  if (env.DEV_FIREBASE_PROJECT_ID && env.REACT_APP_FIREBASE_PROJECT_ID &&
      env.REACT_APP_FIREBASE_PROJECT_ID !== env.DEV_FIREBASE_PROJECT_ID) {
    throw new EnvIsolationError('DEV_CLIENT_FIREBASE_PROJECT_MISMATCH');
  }
  // TonConnect manifest (baked into the bundle) must not point at production.
  if (/enma\.su|enma-silk\.vercel\.app/i.test(String(env.REACT_APP_TONCONNECT_MANIFEST || ''))) {
    throw new EnvIsolationError('DEV_CLIENT_TONCONNECT_IS_PROD');
  }
  // Client links to the bot (AuthScreen) default to the production bot.
  if (!env.REACT_APP_BOT_USERNAME) throw new EnvIsolationError('DEV_CLIENT_BOT_USERNAME_MISSING');
  if (String(env.REACT_APP_BOT_USERNAME).toLowerCase() === PROD_BOT_USERNAME.toLowerCase()) {
    throw new EnvIsolationError('DEV_CLIENT_USES_PROD_BOT');
  }
  const origin = originOf(env.REACT_APP_URL);
  if (origin && PROD_ORIGINS.includes(origin)) throw new EnvIsolationError('DEV_URL_IS_PROD');
  if (/^https?:\/\/(www\.)?enma\.su(\/|$)/i.test(String(env.REACT_APP_URL || ''))) {
    throw new EnvIsolationError('DEV_URL_IS_PROD');
  }
}

/**
 * Inbound/outbound chat allow-list. Production: always true (unchanged).
 * DEV: only chat ids listed in DEV_ALLOWED_CHAT_IDS.
 */
function isChatAllowed(chatId, env = process.env) {
  if (getEnvName(env) === 'production') return true;
  if (chatId === undefined || chatId === null) return false;
  return parseChatIds(env.DEV_ALLOWED_CHAT_IDS).includes(String(chatId));
}

module.exports = {
  PROD_FIREBASE_PROJECT_ID, PROD_VERCEL_PROJECT_ID, PROD_BOT_USERNAME,
  EnvIsolationError, getEnvName, assertEnvironmentIsolation, assertClientConfig, isChatAllowed,
};
