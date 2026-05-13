/**
 * Centralised access to client-side environment variables.
 *
 * This module runs in the browser (React/CRA).  Only REACT_APP_* variables are
 * available here — CRA strips all other process.env keys at build time.
 *
 * Server-only secrets (TELEGRAM_BOT_TOKEN, CRON_SECRET, etc.) live in
 * api/_lib/serverEnv.js which is never bundled into the client.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // In development, throw loudly so missing vars are caught immediately.
    // In production the build would have already failed to inject the var.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
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
  appUrl: optional('REACT_APP_URL', 'https://enma.vercel.app'),
} as const;

// Export individual values for convenient destructuring.
export const { firebase: firebaseConfig, enableClientReminders } = env;
