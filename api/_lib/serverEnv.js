'use strict';

/**
 * Centralised access to server-side environment variables.
 * Call get() / require() instead of reading process.env directly so that
 * missing-variable errors surface at request time with a clear message.
 */

/**
 * @param {string} name
 * @returns {string}
 * @throws if the variable is not set
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * @param {string} name
 * @param {string} [defaultValue]
 * @returns {string | undefined}
 */
function optionalEnv(name, defaultValue) {
  return process.env[name] || defaultValue;
}

module.exports = {
  get TELEGRAM_BOT_TOKEN() { return requireEnv('TELEGRAM_BOT_TOKEN'); },
  get TELEGRAM_WEBHOOK_SECRET() { return optionalEnv('TELEGRAM_WEBHOOK_SECRET'); },
  get CRON_SECRET() { return optionalEnv('CRON_SECRET'); },
  get FIREBASE_SERVICE_ACCOUNT() { return requireEnv('FIREBASE_SERVICE_ACCOUNT'); },
  get APP_URL() { return optionalEnv('APP_URL', 'https://enma.vercel.app'); },
};
