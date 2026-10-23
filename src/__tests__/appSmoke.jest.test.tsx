import React from 'react';
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';

// Smoke test of the real <App/> shell with Firebase / Telegram / TonConnect
// replaced by inert fakes: it proves the screens mount and navigate, that the
// data listeners are wired and cleaned up, and that Settings (with TonConnect)
// is only loaded when opened. It does not validate business data.

// Public client config the app insists on at import time (dummy values).
Object.assign(process.env, {
  REACT_APP_FIREBASE_API_KEY: 'test-key',
  REACT_APP_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
  REACT_APP_FIREBASE_PROJECT_ID: 'test-project',
  REACT_APP_FIREBASE_STORAGE_BUCKET: 'test.appspot.com',
  REACT_APP_FIREBASE_MESSAGING_SENDER_ID: '0',
  REACT_APP_FIREBASE_APP_ID: 'test-app',
});

// The first test also pays for loading and transforming the whole app: on a small CI runner
// that takes well over jest's default 5 s.
jest.setTimeout(60_000);

const mockAuth: { callback: ((u: unknown) => void) | null } = { callback: null };
const mockSnapshotUnsubs: jest.Mock[] = [];
const mockListenedPaths: string[] = [];
const mockTonLoads = { count: 0 };

jest.mock('../firebase', () => ({ auth: { __auth: true }, db: { __db: true }, default: {} }));

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    mockAuth.callback = cb;
    return jest.fn();
  },
  signInWithCustomToken: jest.fn(),
  signOut: jest.fn(async () => undefined),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  updateProfile: jest.fn(),
}));

jest.mock('firebase/firestore', () => {
  const emptySnap = {
    docs: [], size: 0, empty: true, docChanges: () => [], forEach: () => undefined,
    exists: () => false, data: () => undefined,
  };
  return {
    collection: (_db: unknown, name: string) => ({ __path: name }),
    doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
    query: (ref: { __path: string }) => ({ __path: ref.__path }),
    where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    onSnapshot: (ref: { __path: string }, next: (s: unknown) => void) => {
      mockListenedPaths.push(ref.__path);
      const unsub = jest.fn();
      mockSnapshotUnsubs.push(unsub);
      setTimeout(() => next(emptySnap), 0);
      return unsub;
    },
    getDoc: jest.fn(async () => emptySnap),
    getDocs: jest.fn(async () => emptySnap),
    setDoc: jest.fn(async () => undefined),
    updateDoc: jest.fn(async () => undefined),
    deleteDoc: jest.fn(async () => undefined),
    runTransaction: jest.fn(),
    arrayUnion: (...v: unknown[]) => v,
    serverTimestamp: () => 'SERVER_TS',
    Timestamp: { fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }), now: () => ({ seconds: 0 }) },
  };
});

jest.mock('@tonconnect/ui-react', () => {
  mockTonLoads.count += 1;
  return {
    TonConnectUIProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useTonConnectUI: () => [{ openModal: jest.fn(), disconnect: jest.fn(), sendTransaction: jest.fn() }],
    useTonAddress: () => '',
    useTonWallet: () => null,
  };
});

jest.mock('../components/SettingsScreen', () => ({
  __esModule: true,
  default: () => <div data-testid="settings-screen">settings</div>,
}));

const fakeUser = {
  uid: 'smoke-user', email: 'smoke@example.com', displayName: null,
  getIdToken: async () => 'fake-token',
};

const signIn = async () => {
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(fakeUser); });
};

beforeEach(() => {
  mockAuth.callback = null;
  mockSnapshotUnsubs.length = 0;
  mockListenedPaths.length = 0;
  localStorage.clear();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ rates: {}, ok: true }) })) as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // jsdom lacks these browser APIs used by the shell.
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
  // No Telegram unless a test sets it up.
  delete window.Telegram;
  delete window.__enmaTgSdk;
  document.head.innerHTML = '';
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => jest.restoreAllMocks());

const loadApp = async () => (await import('../App')).default;

test('signed out (no Telegram): shows the sign-in screen, not the app shell', async () => {
  const App = await loadApp();
  render(<App />);
  await act(async () => { mockAuth.callback!(null); });
  expect(await screen.findAllByRole('textbox')).not.toHaveLength(0);
  expect(screen.queryByRole('navigation', { name: /primary navigation/i })).toBeNull();
});

test('signed in: the shell mounts with all five primary tabs and the day view', async () => {
  const App = await loadApp();
  render(<App />);
  await signIn();
  const nav = await screen.findByRole('navigation', { name: /primary navigation/i });
  const labels = within(nav).getAllByRole('button').map(b => b.textContent);
  expect(labels).toEqual(['Day', 'Calendar', 'Notes', 'Finance', 'Habits']);
});

test('every primary tab can be opened without errors', async () => {
  const App = await loadApp();
  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<App />);
  await signIn();
  const nav = await screen.findByRole('navigation', { name: /primary navigation/i });
  for (const label of ['Calendar', 'Notes', 'Finance', 'Habits', 'Day']) {
    fireEvent.click(within(nav).getByRole('button', { name: label }));
    // All tabs but Day are loaded on first use: wait for the chunk.
    await waitFor(() => expect(screen.queryByTestId('tab-loading')).toBeNull());
    expect(screen.queryByTestId('error-fallback')).toBeNull();
    expect(screen.getByRole('main').textContent?.length).toBeGreaterThan(0);
  }
  const reactErrors = errors.mock.calls.filter(c => /Warning|Error: Uncaught|The above error/.test(String(c[0])));
  expect(reactErrors).toEqual([]);
});

test('data listeners are attached for the signed-in user and released on unmount (no leaks)', async () => {
  const App = await loadApp();
  const { unmount } = render(<App />);
  await signIn();
  await act(async () => { await new Promise(r => setTimeout(r, 250)); }); // start delay of the collection listeners
  for (const path of ['transactions', 'habits', 'tasks', 'reminders', 'subscriptions/smoke-user', 'users/smoke-user']) {
    expect(mockListenedPaths).toContain(path);
  }
  unmount();
  expect(mockSnapshotUnsubs.length).toBeGreaterThan(0);
  for (const unsub of mockSnapshotUnsubs) expect(unsub).toHaveBeenCalled();
});

test('TonConnect and Settings are not loaded at startup, only when Settings is opened', async () => {
  const App = await loadApp();
  render(<App />);
  await signIn();
  await screen.findByRole('navigation', { name: /primary navigation/i });
  expect(mockTonLoads.count).toBe(0);
  expect(screen.queryByTestId('settings-screen')).toBeNull();
  // Settings is reached through the header gear.
  const gear = screen.getAllByRole('button').find(b => /settings|настройки/i.test(b.getAttribute('aria-label') ?? b.getAttribute('title') ?? ''));
  expect(gear).toBeTruthy();
  fireEvent.click(gear!);
  expect(await screen.findByTestId('settings-screen')).toBeTruthy();
  expect(mockTonLoads.count).toBe(1);
});

// Inside Telegram with the SDK still loading (it no longer blocks the page):
// the shell waits for it, so its first frame already has Telegram's theme;
// and a missing SDK gets the Telegram retry screen, never the email form.
const openInsideTelegram = () => {
  window.history.replaceState(null, '', '/#tgWebAppData=x&tgWebAppVersion=8.0&tgWebAppPlatform=ios');
  const script = document.createElement('script');
  script.setAttribute('src', 'https://telegram.org/js/telegram-web-app.js');
  document.head.appendChild(script);
  return script;
};

test('inside Telegram, saved session: no shell until the SDK has run, then the shell in Telegram\'s theme, ready() once', async () => {
  const script = openInsideTelegram();
  const ready = jest.fn();
  const App = await loadApp();
  render(<App />);
  await signIn();
  expect(screen.queryByRole('navigation', { name: /primary navigation/i })).toBeNull();
  await act(async () => {
    window.Telegram = { WebApp: {
      initData: 'signed', initDataUnsafe: {}, colorScheme: 'light', ready, expand: jest.fn(),
    } };
    window.__enmaTgSdk = 'loaded';
    script.dispatchEvent(new Event('load'));
  });
  expect(await screen.findByRole('navigation', { name: /primary navigation/i })).toBeTruthy();
  expect(document.body).toHaveClass('theme-light');
  expect(ready).toHaveBeenCalledTimes(1);
});

test('inside Telegram, no session, SDK failed: the Telegram retry screen, not the email form', async () => {
  const script = openInsideTelegram();
  const App = await loadApp();
  render(<App />);
  await act(async () => { mockAuth.callback!(null); });
  await act(async () => { window.__enmaTgSdk = 'failed'; script.dispatchEvent(new Event('error')); });
  expect(await screen.findByText(/Mini App library|библиотеку Telegram/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Retry Telegram sign-in|Повторить вход через Telegram/ })).toBeTruthy();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(screen.queryByRole('navigation', { name: /primary navigation/i })).toBeNull();
});
