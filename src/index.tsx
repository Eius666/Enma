import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';
import { checkBuildFreshness, unregisterStaleServiceWorkers } from './buildFreshness';
import ErrorBoundary, { ErrorFallback } from './components/ErrorBoundary';

// When the main bundle started running — read by the startup diagnostics
// (src/lib/perfMarks.ts). A native call, no import: main.js stays as small.
try { performance.mark('enma:index'); } catch { /* unsupported */ }

// Runs before anything else — a stale cached bundle (Telegram WebView / a
// long-lived browser tab) needs to catch itself as early as possible.
unregisterStaleServiceWorkers();
checkBuildFreshness();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

// The app bundle (or a lazy chunk) failed to load or evaluate: show the
// fallback instead of a blank page, and leave a diagnostic for developers.
const showBootFailure = (error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  console.error(`[bootstrap] failed to start (${name})`);
  root.render(<ErrorFallback />);
};

if (window.location.pathname.startsWith('/admin')) {
  import('./admin/App')
    .then(({ default: AdminApp }) => {
      root.render(
        <ErrorBoundary>
          <AdminApp />
        </ErrorBoundary>
      );
    })
    .catch(showBootFailure);
} else {
  // Firebase Auth starts restoring the session while the app chunk is still
  // downloading (src/firebaseApp.ts). A failure here is reported by the app's
  // own import just below, which loads the same module.
  import('./firebaseApp').catch(() => undefined);
  import('./App')
    .then(({ default: App }) => {
      root.render(
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      );
    })
    .catch(showBootFailure);
}

reportWebVitals();
