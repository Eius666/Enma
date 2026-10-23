import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'firebase/auth';
import { firebaseConfig } from './config/env';

// The Firebase app and Auth — the one instance the whole app uses (src/firebase.ts
// re-exports it). src/index.tsx asks for this module next to the app chunk, so
// restoring the saved session (a read from this device, then the token refresh
// and account lookup Firebase does on every start) begins as soon as this small
// module arrives, instead of after the app's much larger code has downloaded.
//
// initializeAuth with the same session storage getAuth() uses (same order, so
// the session saved by earlier versions is found and restored exactly as
// before), but without getAuth()'s popup/redirect helper. On iPhones and other
// mobile browsers that helper, before the saved session is even reported,
// downloads Google's gapi loader and a hidden iframe from the authDomain — an
// extra chain of requests on every start. The app signs in only with a custom
// token (Telegram) or email and password, never with a popup or a redirect.

// When Auth starts (read by the startup diagnostics, src/lib/perfMarks.ts).
try { performance.mark('enma:auth-init'); } catch { /* unsupported */ }

export const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
});
