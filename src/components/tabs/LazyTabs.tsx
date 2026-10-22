import React, { Suspense } from 'react';
import type { CalendarTab } from './CalendarTab';
import type { NotesTab } from './NotesTab';
import type { FinanceTab } from './FinanceTab';
import type { HabitsTab } from './HabitsTab';

// The Calendar, Notes, Finance and Habits tabs are not part of the startup
// bundle (the Day tab, shown first, is) — same approach as LazySettings.
// No webpackPrefetch hint: it made Chromium start these downloads as soon as
// the app chunk arrived, sharing the connection with the app's own (larger)
// chunk mid-startup; preloadTabs below loads them once the shell is up.
const loadCalendarTab = () => import('./CalendarTab');
const loadNotesTab    = () => import('./NotesTab');
const loadFinanceTab  = () => import('./FinanceTab');
const loadHabitsTab   = () => import('./HabitsTab');

const CalendarTabChunk = React.lazy(() => loadCalendarTab().then(m => ({ default: m.CalendarTab })));
const NotesTabChunk    = React.lazy(() => loadNotesTab().then(m => ({ default: m.NotesTab })));
const FinanceTabChunk  = React.lazy(() => loadFinanceTab().then(m => ({ default: m.FinanceTab })));
const HabitsTabChunk   = React.lazy(() => loadHabitsTab().then(m => ({ default: m.HabitsTab })));

// Loads the four tab chunks in the background. The shell calls it shortly
// after it is on screen: WebKit (Telegram on iOS) ignores the prefetch hint
// above, and without this a tab opened for the first time with no network
// would fail to load — when these tabs were part of the startup bundle they
// always opened offline once the app had started. Never rejects: a failed
// load is simply tried again when the tab is opened.
export function preloadTabs(): Promise<void> {
  const loads = [loadCalendarTab, loadNotesTab, loadFinanceTab, loadHabitsTab];
  return Promise.all(loads.map(load => load().then(() => undefined, () => undefined))).then(() => undefined);
}

const fallback = <div aria-busy="true" data-testid="tab-loading" style={{ minHeight: '40vh' }} />;

export const LazyCalendarTab: React.FC<React.ComponentProps<typeof CalendarTab>> = props => (
  <Suspense fallback={fallback}><CalendarTabChunk {...props} /></Suspense>
);
export const LazyNotesTab: React.FC<React.ComponentProps<typeof NotesTab>> = props => (
  <Suspense fallback={fallback}><NotesTabChunk {...props} /></Suspense>
);
export const LazyFinanceTab: React.FC<React.ComponentProps<typeof FinanceTab>> = props => (
  <Suspense fallback={fallback}><FinanceTabChunk {...props} /></Suspense>
);
export const LazyHabitsTab: React.FC<React.ComponentProps<typeof HabitsTab>> = props => (
  <Suspense fallback={fallback}><HabitsTabChunk {...props} /></Suspense>
);
