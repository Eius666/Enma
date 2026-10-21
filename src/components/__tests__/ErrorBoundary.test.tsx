import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary, { ErrorFallback } from '../ErrorBoundary';

const SECRET = 'SECRET-USER-NOTE-CONTENT-12345';

function Boom(): React.ReactElement {
  throw new Error(SECRET);
}

function EffectBoom(): React.ReactElement {
  React.useEffect(() => {
    throw new Error(SECRET);
  }, []);
  return <div>mounted</div>;
}

describe('ErrorBoundary', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    // React logs caught render errors; keep test output clean and inspectable.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  test('renders children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <div>healthy app</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('healthy app')).toBeTruthy();
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  test('a render error is caught and a fallback is shown (no blank screen)', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('error-fallback')).toBeTruthy();
    expect(screen.getByRole('alert').textContent?.trim().length).toBeGreaterThan(0);
  });

  test('an error thrown in an effect is caught too', () => {
    render(
      <ErrorBoundary>
        <EffectBoom />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('error-fallback')).toBeTruthy();
  });

  test('the fallback offers a restart action that reloads the page', () => {
    const reload = jest.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      fireEvent.click(screen.getByRole('button'));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  test('technical details of the error are not shown to the user', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    const text = screen.getByTestId('error-fallback').textContent ?? '';
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/Error:|at \w+|\.tsx|stack/i);
  });

  test('production logging omits the error message (user content) but keeps developers informed', () => {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      const logged = errorSpy.mock.calls
        .filter(call => typeof call[0] === 'string' && call[0].startsWith('[ErrorBoundary]'))
        .map(call => call.join(' '))
        .join('\n');
      expect(logged).toContain('[ErrorBoundary] render error (Error)');
      expect(logged).not.toContain(SECRET);
    } finally {
      env.NODE_ENV = previous;
    }
  });

  test('ErrorFallback is usable standalone (used when the bundle fails to load)', () => {
    render(<ErrorFallback />);
    expect(screen.getByTestId('error-fallback')).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
