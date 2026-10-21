import React from 'react';

// Last line of defence against a blank screen: if rendering (or a mount/update
// effect) of anything below throws, show a short message and a restart button
// instead of unmounting the whole tree.
//
// NOT caught by React error boundaries (by design of React): errors in event
// handlers, in asynchronous code (promises, fetch callbacks, timers,
// Firestore snapshot callbacks), errors thrown during server rendering, and
// errors thrown by the boundary itself. Those must be handled where they occur.

type Props = { children?: React.ReactNode };
type State = { failed: boolean };

export function ErrorFallback(): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="error-fallback"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>Что-то пошло не так / Something went wrong</h1>
      <p style={{ margin: 0, opacity: 0.8 }}>
        Произошла ошибка. Перезапустите приложение.
        <br />
        An error occurred. Please restart the app.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: '10px 20px', fontSize: 16, borderRadius: 8, cursor: 'pointer' }}
      >
        Перезапустить / Restart
      </button>
    </div>
  );
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Development: full details for developers. Production: only the error
    // class and the component stack (component names only) — never the error
    // message, which may contain user content.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info.componentStack);
      return;
    }
    const name = typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error';
    const stack = String(info?.componentStack ?? '').slice(0, 800);
    console.error(`[ErrorBoundary] render error (${name})${stack}`);
  }

  render(): React.ReactNode {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
