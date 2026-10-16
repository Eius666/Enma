/**
 * Centralised access to client-side environment variables.
 *
 * This module runs in the browser (React/CRA).  Only REACT_APP_* variables are
 * available here — CRA strips all other process.env keys at build time.
 *
 * Server-only secrets (TELEGRAM_BOT_TOKEN, CRON_SECRET, etc.) live in
 * api/_lib/serverEnv.js which is never bundled into the client.
 */

// Vercel's CLI masks any env var marked "Sensitive" as the literal 11-char
// string "[SENSITIVE]" whenever its real value is fetched through the CLI
// (vercel env pull, and — confirmed the hard way — a LOCAL `vercel build`,
// which fetches env the same way). A full remote `vercel --prod` deploy
// (Vercel's own build infra, not the local CLI env-fetch path) injects the
// real value. Without this check, a build that hit the masked path would
// silently bake "[SENSITIVE]" into the client bundle as if it were a real
// Firebase config value, surfacing only much later as Firebase's own
// confusing `auth/api-key-not-valid` error — see
// TELEGRAM_PASSWORDLESS_AUTOAUTH audit, targeted-recovery round.
const SENSITIVE_PLACEHOLDER = '[SENSITIVE]';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // In development, throw loudly so missing vars are caught immediately.
    // In production the build would have already failed to inject the var.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value === SENSITIVE_PLACEHOLDER) {
    throw new Error(
      `${name} resolved to the literal placeholder "${SENSITIVE_PLACEHOLDER}" instead of its real value — ` +
      'this build did not inject the actual env var. Rebuild with a full remote `vercel --prod` deploy ' +
      '(not `vercel build` + `vercel deploy --prebuilt`, which fetches env through the CLI path that masks ' +
      'any Sensitive-marked variable).'
    );
  }
  return value;
}

function optional(name: string, defaultValue?: string): string | undefined {
  const value = process.env[name];
  // Same masked-build guard as required(), but graceful: optional() already
  // means "fall back if absent", so a masked value falls back too instead
  // of silently becoming the literal string "[SENSITIVE]".
  if (!value || value === SENSITIVE_PLACEHOLDER) return defaultValue;
  return value;
}

export const env = {
  // ---------------------------------------------------------------------------
  // Firebase (public — safe to expose in client bundle)
  // ---------------------------------------------------------------------------
  firebase: {
    apiKey:            required('REACT_APP_FIREBASE_API_KEY'),
    authDomain:        required('REACT_APP_FIREBASE_AUTH_DOMAIN'),
    projectId:         required('REACT_APP_FIREBASE_PROJECT_ID'),
    storageBucket:     required('REACT_APP_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: required('REACT_APP_FIREBASE_MESSAGING_SENDER_ID'),
    appId:             required('REACT_APP_FIREBASE_APP_ID'),
  },

  // ---------------------------------------------------------------------------
  // Feature flags
  // ---------------------------------------------------------------------------
  /** Enable client-side reminder polling (set to 'true' to activate). */
  enableClientReminders: optional('REACT_APP_CLIENT_REMINDERS', 'false') === 'true',

  // ---------------------------------------------------------------------------
  // App metadata
  // ---------------------------------------------------------------------------
  // Falls back to the browser's own origin so this stays correct on whichever
  // domain actually served the app (old or new), instead of a hardcoded guess.
  /** Public bot username for t.me links. DEV sets REACT_APP_BOT_USERNAME; default keeps production. */
  botUsername: optional('REACT_APP_BOT_USERNAME', 'YourArc_bot') as string,

  appUrl: optional(
    'REACT_APP_URL',
    typeof window !== 'undefined' ? window.location.origin : 'https://enma.su'
  ),
} as const;

// Export individual values for convenient destructuring.
export const { firebase: firebaseConfig, enableClientReminders } = env;
