import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { firebaseConfig } from './config/env';

// The Firebase app and Auth — the one instance the whole app uses (src/firebase.ts
// re-exports it). src/index.tsx asks for this module next to the app chunk, so
// restoring the saved session (a read from this device, then the token refresh
// and account lookup Firebase does on every start) begins as soon as this small
// module arrives, instead of after the app's much larger code has downloaded.
// Nothing about how sign-in works changes; only when it starts.
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
