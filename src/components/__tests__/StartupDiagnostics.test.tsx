import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartupDiagnostics } from '../StartupDiagnostics';

// BUG-08: the Settings switch that records startup timings on a DEV build,
// and the text of the last start. Only step names and milliseconds.

const RUN = {
  recordedAt: '2026-10-22T15:10:59.729Z',
  navigationType: 'navigate',
  page: { htmlReceived: 640, bundleStarted: 1900, domReady: 1950 },
  requests: [{ name: 'auth: accounts:lookup', start: 2500, end: 3300, count: 1 }],
  marks: [{ phase: 'first-render', ms: 2300 }, { phase: 'shell-rendered', ms: 3450 }],
};

beforeEach(() => localStorage.clear());

test('off by default; switching on is stored on this device and explained', () => {
  render(<StartupDiagnostics language="ru" />);
  const toggle = screen.getByRole('switch', { name: 'Диагностика запуска' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(localStorage.getItem('enma.startupDiagnostics')).toBe('1');
  expect(screen.getByText(/Закройте мини-приложение и откройте снова/)).toBeTruthy();
});

test('with a recorded start, its timings are shown as text; switching off forgets them', () => {
  localStorage.setItem('enma.startupDiagnostics', '1');
  localStorage.setItem('enma.startupDiagnostics.lastRun', JSON.stringify(RUN));
  render(<StartupDiagnostics language="ru" />);
  expect(screen.getByText(/Первый экран: 2300 мс/)).toBeTruthy();
  expect(screen.getByText(/auth: accounts:lookup: 2500→3300/)).toBeTruthy();
  fireEvent.click(screen.getByRole('switch', { name: 'Диагностика запуска' }));
  expect(localStorage.getItem('enma.startupDiagnostics')).toBeNull();
  expect(localStorage.getItem('enma.startupDiagnostics.lastRun')).toBeNull();
  expect(screen.queryByText(/Первый экран/)).toBeNull();
});
