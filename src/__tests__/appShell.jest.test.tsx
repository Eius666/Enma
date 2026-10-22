import React from 'react';
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';

// Behaviour of the <App/> shell around the screens: Telegram auto sign-in and
// its outcome screens, onboarding for a new Telegram user, the header (name,
// plan badge), the trial-ended banner and tab navigation. Firebase, Telegram
// and the network are fakes; nothing leaves the process.

Object.assign(process.env, {
  REACT_APP_FIREBASE_API_KEY: 'test-key',
  REACT_APP_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
  REACT_APP_FIREBASE_PROJECT_ID: 'test-project',
  REACT_APP_FIREBASE_STORAGE_BUCKET: 'test.appspot.com',
  REACT_APP_FIREBASE_MESSAGING_SENDER_ID: '0',
  REACT_APP_FIREBASE_APP_ID: 'test-app',
});

jest.setTimeout(60_000);

const mockAuth: { callback: ((u: unknown) => void) | null; customTokens: unknown[][]; signOuts: number } = {
  callback: null,
  customTokens: [],
  signOuts: 0,
};
const mockDocs: Record<string, Record<string, unknown> | undefined> = {};
const mockWrites: Array<{ path: string; data: unknown }> = [];

jest.mock('../firebase', () => ({ auth: { __auth: true }, db: { __db: true }, default: {} }));

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    mockAuth.callback = cb;
    return jest.fn();
  },
  signInWithCustomToken: async (...args: unknown[]) => { mockAuth.customTokens.push(args); },
  signOut: async () => { mockAuth.signOuts += 1; },
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
  updateProfile: jest.fn(),
}));

jest.mock('firebase/firestore', () => {
  const snapFor = (path: string) => {
    const data = mockDocs[path];
    return {
      docs: [], size: 0, empty: true, docChanges: () => [], forEach: () => undefined,
      exists: () => data !== undefined, data: () => data, id: path.split('/').pop(),
    };
  };
  return {
    collection: (_db: unknown, name: string) => ({ __path: name }),
    doc: (_db: unknown, ...parts: string[]) => ({ __path: parts.join('/') }),
    query: (ref: { __path: string }) => ({ __path: ref.__path }),
    where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    onSnapshot: (ref: { __path: string }, next: (s: unknown) => void) => {
      setTimeout(() => next(snapFor(ref.__path)), 0);
      return jest.fn();
    },
    // Plain functions, not jest.fn: CRA resets mock implementations before each test.
    getDoc: async (ref: { __path: string }) => snapFor(ref.__path),
    getDocs: async () => snapFor(''),
    setDoc: async (ref: { __path: string }, data: unknown) => { mockWrites.push({ path: ref.__path, data }); },
    updateDoc: async () => undefined,
    deleteDoc: async () => undefined,
    runTransaction: async () => undefined,
    arrayUnion: (...v: unknown[]) => v,
    serverTimestamp: () => 'SERVER_TS',
    Timestamp: { fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }), now: () => ({ seconds: 0 }) },
  };
});

jest.mock('@tonconnect/ui-react', () => ({
  TonConnectUIProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTonConnectUI: () => [{ openModal: jest.fn(), disconnect: jest.fn(), sendTransaction: jest.fn() }],
  useTonAddress: () => '',
  useTonWallet: () => null,
}));

jest.mock('../components/SettingsScreen', () => ({
  __esModule: true,
  default: () => <div data-testid="settings-screen">settings</div>,
}));

// The real tab loaders, counting the background preloads.
const mockPreload = { calls: 0 };
jest.mock('../components/tabs/LazyTabs', () => {
  const actual = jest.requireActual('../components/tabs/LazyTabs');
  return { ...actual, preloadTabs: () => { mockPreload.calls += 1; return actual.preloadTabs(); } };
});

type FetchCall = { url: string; body: unknown };
const fetchCalls: FetchCall[] = [];
let authAnswer: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function installTelegram() {
  (window as unknown as { Telegram?: unknown }).Telegram = {
    WebApp: {
      initData: 'query_id=AA&user=%7B%22id%22%3A42%7D&auth_date=1&hash=abc',
      initDataUnsafe: { user: { id: 42, first_name: 'Ann', last_name: 'Lee', username: 'annlee' } },
      ready: jest.fn(), expand: jest.fn(), onEvent: jest.fn(), offEvent: jest.fn(),
      viewportHeight: 640, colorScheme: 'dark',
    },
  };
}

beforeEach(() => {
  mockAuth.callback = null;
  mockAuth.customTokens = [];
  mockAuth.signOuts = 0;
  for (const k of Object.keys(mockDocs)) delete mockDocs[k];
  mockWrites.length = 0;
  fetchCalls.length = 0;
  mockPreload.calls = 0;
  localStorage.clear();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
  authAnswer = async () => ({ ok: true, status: 200, json: async () => ({ token: 'custom-token', isNewUser: false }) });
  global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/api/auth/telegram')) return authAnswer();
    return { ok: true, status: 200, json: async () => ({ rates: {}, ok: true, insights: [] }) };
  }) as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => jest.restoreAllMocks());

const loadApp = async () => (await import('../App')).default;
const emailUser = { uid: 'u-email', email: 'maria@example.com', displayName: null, getIdToken: async () => 't' };
const tgUser = { uid: 'tg_42', email: null, displayName: null, getIdToken: async () => 't' };

async function renderSignedIn(user: unknown = emailUser) {
  const App = await loadApp();
  const utils = render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(user); });
  await screen.findByRole('navigation', { name: /primary navigation/i });
  return utils;
}

// ── Telegram auto sign-in ───────────────────────────────────────────────────

test('Telegram without a session: a loading screen while signing in, then the app', async () => {
  installTelegram();
  let release!: () => void;
  authAnswer = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ token: 'custom-token', isNewUser: false }) }); });
  const App = await loadApp();
  render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(null); });
  expect(await screen.findByText('Signing in via Telegram…')).toBeTruthy();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0); // never the manual login form meanwhile
  const authCall = fetchCalls.find(c => c.url.includes('/api/auth/telegram'))!;
  expect(authCall.body).toEqual({ initData: 'query_id=AA&user=%7B%22id%22%3A42%7D&auth_date=1&hash=abc' });
  await act(async () => { release(); });
  await waitFor(() => expect(mockAuth.customTokens).toEqual([[{ __auth: true }, 'custom-token']]));
  await act(async () => { mockAuth.callback!(tgUser); });
  expect(await screen.findByRole('navigation', { name: /primary navigation/i })).toBeTruthy();
});

test('a new Telegram user is offered the onboarding after sign-in', async () => {
  installTelegram();
  authAnswer = async () => ({ ok: true, status: 200, json: async () => ({ token: 'custom-token', isNewUser: true }) });
  const App = await loadApp();
  render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(null); });
  await waitFor(() => expect(mockAuth.customTokens).toHaveLength(1));
  await act(async () => { mockAuth.callback!(tgUser); });
  await screen.findByRole('navigation', { name: /primary navigation/i });
  expect(screen.getByRole('heading', { name: 'AI Analysis Preview' })).toBeTruthy();
});

test('the onboarding is a modal: one tap on the backdrop closes it and it does not come back', async () => {
  installTelegram();
  authAnswer = async () => ({ ok: true, status: 200, json: async () => ({ token: 'custom-token', isNewUser: true }) });
  const App = await loadApp();
  render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(null); });
  await waitFor(() => expect(mockAuth.customTokens).toHaveLength(1));
  await act(async () => { mockAuth.callback!(tgUser); });
  expect(await screen.findByRole('dialog', { name: 'AI Analysis Preview' })).toBeTruthy();
  fireEvent.click(screen.getByTestId('modal-backdrop'));
  expect(screen.queryByRole('dialog')).toBeNull();
  const nav = screen.getByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }));
  await screen.findByRole('button', { name: 'New note' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Day' }));
  await act(async () => { await new Promise(r => setTimeout(r, 20)); }); // the Day tab's feed settles
  expect(screen.queryByRole('dialog')).toBeNull();
});

async function renderFailedTelegramSignIn(answer: typeof authAnswer) {
  installTelegram();
  authAnswer = answer;
  const App = await loadApp();
  render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(null); });
}
const telegramAuthCalls = () => fetchCalls.filter(c => c.url.includes('/api/auth/telegram')).length;

test.each([
  ['a network failure', async () => { throw new TypeError('Failed to fetch'); }, "Couldn't sign in via Telegram automatically."],
  ['an identity conflict', async () => ({ ok: false, status: 409, json: async () => ({ code: 'TELEGRAM_IDENTITY_CONFLICT' }) }), "We found more than one Enma account linked to your Telegram — we can't pick automatically."],
  ['a backend error', async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) }), "Couldn't sign in via Telegram automatically."],
])('Telegram sign-in fails with %s: a retry screen, never a silent new account', async (_name, answer, title) => {
  await renderFailedTelegramSignIn(answer as typeof authAnswer);
  expect(await screen.findByText(title as string)).toBeTruthy();
  expect(mockAuth.customTokens).toHaveLength(0);
  expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Retry Telegram sign-in', 'Use another way to sign in']);
  const before = telegramAuthCalls();
  fireEvent.click(screen.getByRole('button', { name: 'Retry Telegram sign-in' }));
  await waitFor(() => expect(telegramAuthCalls()).toBe(before + 1));
  fireEvent.click(await screen.findByRole('button', { name: 'Use another way to sign in' }));
  // The manual sign-in form is reached only by this explicit choice.
  expect(await screen.findAllByRole('textbox')).not.toHaveLength(0);
});

test('Telegram sign-in needs account recovery: one action leading to the manual sign-in', async () => {
  await renderFailedTelegramSignIn(async () => ({ ok: false, status: 409, json: async () => ({ code: 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED' }) }));
  expect(await screen.findByText(/couldn't automatically restore your Enma account/)).toBeTruthy();
  expect(mockAuth.customTokens).toHaveLength(0);
  expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Restore account']);
  fireEvent.click(screen.getByRole('button', { name: 'Restore account' }));
  expect(await screen.findAllByRole('textbox')).not.toHaveLength(0);
  expect(telegramAuthCalls()).toBe(1);
});

test('an existing session inside Telegram does not trigger Telegram sign-in again', async () => {
  installTelegram();
  await renderSignedIn(emailUser);
  expect(fetchCalls.filter(c => c.url.includes('/api/auth/telegram'))).toHaveLength(0);
  expect(screen.queryByRole('heading', { name: 'AI Analysis Preview' })).toBeNull();
});

// ── Telegram identity sync for a signed-in user ────────────────────────────

test('inside Telegram, the chat id and the Telegram profile mapping are written for the signed-in user', async () => {
  installTelegram();
  await renderSignedIn(emailUser);
  await waitFor(() => expect(mockWrites.some(w => w.path === 'telegramUsers/tg_42')).toBe(true));
  const userWrite = mockWrites.find(w => w.path === 'users/u-email' && (w.data as { chatId?: number }).chatId !== undefined);
  expect(userWrite?.data).toEqual({ chatId: 42, updatedAt: 'SERVER_TS' });
  const mapping = mockWrites.find(w => w.path === 'telegramUsers/tg_42')!.data;
  expect(mapping).toEqual({
    chatId: 42, username: 'annlee', firstName: 'Ann', lastName: 'Lee', languageCode: null,
    firebaseUid: 'u-email', updatedAt: 'SERVER_TS',
  });
});

test('outside Telegram nothing Telegram-related is written', async () => {
  await renderSignedIn(emailUser);
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(mockWrites.filter(w => w.path.startsWith('telegramUsers/') || (w.data as { chatId?: unknown }).chatId !== undefined)).toEqual([]);
});

// ── header ─────────────────────────────────────────────────────────────────

test('header for an e-mail user: initials and nick from the e-mail, no plan badge', async () => {
  await renderSignedIn(emailUser);
  const header = screen.getByRole('banner');
  expect(within(header).getByText('MA').className).toBe('header-avatar');
  expect(within(header).getByText('maria')).toBeTruthy();
  expect(within(header).getByText('maria@example.com')).toBeTruthy();
});

test('header inside Telegram: the Telegram @username and name are used', async () => {
  installTelegram();
  await renderSignedIn(tgUser);
  const header = screen.getByRole('banner');
  expect(within(header).getByText('@annlee')).toBeTruthy();
  expect(within(header).getByText('AN')).toBeTruthy();
  expect(within(header).getByText('annlee')).toBeTruthy(); // shown where the e-mail would be
});

test('header shows the active paid plan', async () => {
  mockDocs['subscriptions/u-email'] = { plan: 'premium', status: 'active', endDate: iso(Date.now() + 20 * DAY) };
  await renderSignedIn(emailUser);
  const header = screen.getByRole('banner');
  expect((await within(header).findByText('PREMIUM')).className).toBe('header-avatar-pro-label');
  expect(within(header).getByText('MA').className).toBe('header-avatar header-avatar--pro');
});

test('header shows a plan the server recorded without an ISO end date (TON payment, admin grant)', async () => {
  mockDocs['subscriptions/u-email'] = { plan: 'pro', status: 'active', endDateMs: Date.now() + 20 * DAY, expiresAt: { toMillis: () => Date.now() + 20 * DAY } };
  await renderSignedIn(emailUser);
  const header = screen.getByRole('banner');
  expect((await within(header).findByText('PRO')).className).toBe('header-avatar-pro-label');
});

test('header shows no plan when the server-side end time has passed, whatever the stale ISO date says', async () => {
  mockDocs['subscriptions/u-email'] = { plan: 'pro', status: 'active', endDate: iso(Date.now() + 20 * DAY), endDateMs: Date.now() - DAY };
  await renderSignedIn(emailUser);
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(within(screen.getByRole('banner')).queryByText('PRO')).toBeNull();
});

// The document registration writes (api/_lib/subscription/plan.js, buildTrialSubscription).
const registrationTrial = (daysLeft: number) => {
  const end = Date.now() + daysLeft * DAY - 1000;
  return {
    plan: 'free', trialPlan: 'premium', period: 'month', status: 'active', paymentMethod: 'trial',
    endDate: iso(end), endDateMs: end, trialEndDate: iso(end), trialEndDateMs: end,
  };
};

test('header shows a running registration trial as TRIAL, not as PREMIUM (BUG-09)', async () => {
  mockDocs['subscriptions/u-email'] = registrationTrial(6);
  await renderSignedIn(emailUser);
  const header = screen.getByRole('banner');
  expect((await within(header).findByText('TRIAL')).className).toBe('header-avatar-pro-label header-avatar-pro-label--trial');
  expect(within(header).queryByText('PREMIUM')).toBeNull();
  expect(within(header).getByText('MA').className).toBe('header-avatar header-avatar--pro');
});

test('header shows a plan paid for during the trial as that plan', async () => {
  mockDocs['subscriptions/u-email'] = { ...registrationTrial(3), plan: 'pro', endDate: iso(Date.now() + 33 * DAY), endDateMs: Date.now() + 33 * DAY, lastPaymentMethod: 'sbp' };
  await renderSignedIn(emailUser);
  const header = screen.getByRole('banner');
  expect((await within(header).findByText('PRO')).className).toBe('header-avatar-pro-label');
  expect(within(header).queryByText('TRIAL')).toBeNull();
});

test('header shows no plan for an ended trial or a cancelled one', async () => {
  mockDocs['subscriptions/u-email'] = { ...registrationTrial(3), status: 'cancelled' };
  await renderSignedIn(emailUser);
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const header = screen.getByRole('banner');
  expect(within(header).queryByText(/TRIAL|PREMIUM|PRO/)).toBeNull();
  expect(within(header).getByText('MA').className).toBe('header-avatar');
});

test('an ended trial without payment shows the upgrade banner leading to Settings', async () => {
  mockDocs['subscriptions/u-email'] = { plan: 'free', trialPlan: 'pro', status: 'expired', endDate: iso(Date.now() - DAY), trialEndDate: iso(Date.now() - DAY) };
  await renderSignedIn(emailUser);
  expect(await screen.findByText('Your trial ended. Upgrade to Pro to keep adding items.')).toBeTruthy();
  expect(within(screen.getByRole('banner')).queryByText(/TRIAL|PRO/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
  expect(await screen.findByTestId('settings-screen')).toBeTruthy();
});

// ── navigation ─────────────────────────────────────────────────────────────

test('Habits tab: the Habits/Goals switch keeps its choice across tab changes', async () => {
  await renderSignedIn(emailUser);
  const nav = screen.getByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav).getByRole('button', { name: 'Habits' }));
  const sections = await screen.findByRole('tablist');
  fireEvent.click(within(sections).getByRole('button', { name: 'Goals' }));
  expect(within(screen.getByRole('tablist')).getByRole('button', { name: 'Goals' }).className).toMatch(/--active/);
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }));
  await screen.findByRole('button', { name: 'New note' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Habits' }));
  expect(within(await screen.findByRole('tablist')).getByRole('button', { name: 'Goals' }).className).toMatch(/--active/);
});

test('the active tab is highlighted and Settings opens from the header gear', async () => {
  await renderSignedIn(emailUser);
  const nav = screen.getByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav).getByRole('button', { name: 'Finance' }));
  expect(within(nav).getByRole('button', { name: 'Finance' }).className).toMatch(/bottom-nav__item--active/);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(await screen.findByTestId('settings-screen')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Settings' }).className).toMatch(/header-icon-btn--active/);
  expect(within(nav).getAllByRole('button').some(b => /--active/.test(b.className))).toBe(false);
});

test('signing out from the header calls Firebase sign-out', async () => {
  await renderSignedIn(emailUser);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(mockAuth.signOuts).toBe(1));
});

// The other tabs are loaded in the background once the app is on screen, so
// they still open when the network is gone afterwards.
test('the other tabs are loaded in the background shortly after the app is shown', async () => {
  await renderSignedIn(emailUser);
  expect(mockPreload.calls).toBe(0); // not while the first data is arriving
  await waitFor(() => expect(mockPreload.calls).toBe(1), { timeout: 3000 });
});

test('nothing is preloaded while the sign-in screen is shown', async () => {
  const App = await loadApp();
  render(<App />);
  await waitFor(() => expect(mockAuth.callback).not.toBeNull());
  await act(async () => { mockAuth.callback!(null); });
  expect(await screen.findAllByRole('textbox')).not.toHaveLength(0);
  await act(async () => { await new Promise(r => setTimeout(r, 1500)); });
  expect(mockPreload.calls).toBe(0);
});

// ── lifecycle: editor state belongs to its tab ─────────────────────────────

test('leaving a tab closes its editor', async () => {
  await renderSignedIn(emailUser);
  const nav = screen.getByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'New note' }));
  expect(screen.queryByRole('button', { name: 'New note' })).toBeNull(); // the editor is open
  fireEvent.click(within(nav).getByRole('button', { name: 'Finance' }));
  await waitFor(() => expect(screen.queryByTestId('tab-loading')).toBeNull());
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }));
  expect(await screen.findByRole('button', { name: 'New note' })).toBeTruthy();
});

test('an editor left open is not reopened for the next account after sign-out', async () => {
  const utils = await renderSignedIn(emailUser);
  const nav = screen.getByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav).getByRole('button', { name: 'Notes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'New note' }));
  await act(async () => { mockAuth.callback!(null); });
  await act(async () => { mockAuth.callback!({ ...emailUser, uid: 'u-other', email: 'other@example.com' }); });
  const nav2 = await screen.findByRole('navigation', { name: /primary navigation/i });
  fireEvent.click(within(nav2).getByRole('button', { name: 'Notes' }));
  expect(await screen.findByRole('button', { name: 'New note' })).toBeTruthy();
  utils.unmount();
});
