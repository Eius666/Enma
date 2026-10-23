import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { launchedFromTelegram, whenTelegramSdkSettled } from '../telegram';
import { useTelegramWebApp, TELEGRAM_SDK_WAIT_MS } from '../hooks/useTelegramWebApp';
import { useAuthBootstrap } from '../hooks/useAuthBootstrap';
import { usePreferences } from '../hooks/usePreferences';

// The Telegram SDK loads without blocking the page (public/index.html). These
// tests drive the real hooks through every order in which the SDK, the saved
// Firebase session and the Telegram sign-in can arrive, with Firebase and the
// network replaced by fakes. What must hold: the signed initData still comes
// only from the SDK, inside Telegram the email screen never appears by itself
// (a missing SDK gets a retry screen), a restored session is never replaced,
// no account is ever created anonymously, and outside Telegram nothing waits.

const mockAuth: {
  listener: ((u: unknown) => void) | null; customTokens: string[]; anonymous: number; signInError: Error | null;
} = { listener: null, customTokens: [], anonymous: 0, signInError: null };
jest.mock('../firebase', () => ({ auth: { __auth: true }, db: {} }));
jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => { mockAuth.listener = cb; return () => undefined; },
  signInWithCustomToken: async (_auth: unknown, token: string) => {
    if (mockAuth.signInError) throw mockAuth.signInError;
    mockAuth.customTokens.push(token);
  },
  signInAnonymously: async () => { mockAuth.anonymous += 1; },
}));

const LAUNCH_SECRET = 'launch-value-that-must-never-be-logged';
const TG_HASH = `#tgWebAppData=${LAUNCH_SECRET}&tgWebAppVersion=8.0&tgWebAppPlatform=ios`;

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };
let fetchBodies: Array<{ url: string; body: unknown }> = [];
let answer: Answer;
let calls: { ready: number; expand: number };
let newUserCallbacks = 0;

function addSdkScript(): HTMLScriptElement {
  const s = document.createElement('script');
  s.setAttribute('src', 'https://telegram.org/js/telegram-web-app.js');
  document.head.appendChild(s);
  return s;
}
// The SDK <script> tags are not UI, so Testing Library queries do not apply.
// eslint-disable-next-line testing-library/no-node-access
const sdkScripts = () => Array.from(document.scripts).filter(s => s.src.includes('telegram-web-app.js'));

function defineWebApp(initData: string, colorScheme: 'light' | 'dark' = 'dark') {
  window.Telegram = {
    WebApp: {
      initData, initDataUnsafe: { user: { id: 1 } }, colorScheme, viewportHeight: 640,
      contentSafeAreaInset: { top: 44, bottom: 34 },
      ready: () => { calls.ready += 1; }, expand: () => { calls.expand += 1; },
    },
  };
}
function sdkLoads(script: HTMLScriptElement, initData: string, colorScheme: 'light' | 'dark' = 'dark') {
  defineWebApp(initData, colorScheme);
  window.__enmaTgSdk = 'loaded';
  script.dispatchEvent(new Event('load'));
}
function sdkFails(script: HTMLScriptElement) {
  window.__enmaTgSdk = 'failed';
  script.dispatchEvent(new Event('error'));
}

let retry: () => void = () => undefined;
function Probe() {
  const { webApp, sdkPending, sdkFailed, retrySdk } = useTelegramWebApp();
  const { theme } = usePreferences(webApp);
  const { authStatus, telegramAuthErrorReason, retryTelegramAuth } = useAuthBootstrap(
    webApp, { pending: sdkPending, failed: sdkFailed, retry: retrySdk }, () => { newUserCallbacks += 1; },
  );
  retry = retryTelegramAuth;
  const reason = authStatus === 'telegram_auth_error' ? `:${telegramAuthErrorReason}` : '';
  return <div data-testid="status" data-theme={theme}>{authStatus}{reason}{sdkPending ? ' (sdk pending)' : ''}</div>;
}
const status = () => screen.getByTestId('status').textContent;

beforeEach(() => {
  delete window.Telegram;
  delete window.__enmaTgSdk;
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('style');
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  mockAuth.listener = null; mockAuth.customTokens = []; mockAuth.anonymous = 0; mockAuth.signInError = null;
  fetchBodies = []; calls = { ready: 0, expand: 0 }; newUserCallbacks = 0;
  answer = { ok: true, status: 200, body: { token: 'custom-token' } };
  global.fetch = (async (url: string, init: RequestInit) => {
    fetchBodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) });
    return { ok: answer.ok, status: answer.status, json: async () => answer.body };
  }) as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('launchedFromTelegram: only the launch parameter names, from the hash or the SDK\'s stored copy', () => {
  test.each([
    ['#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0&tgWebAppPlatform=ios', true],
    ['#tgWebAppVersion=8.0&tgWebAppPlatform=tdesktop', true],
    ['#/notes?tgWebAppData=abc', true],
    ['', false],
    ['#settings', false],
    ['#utm=tgWebAppData', false],
  ])('hash %p -> %p', (hash, expected) => {
    window.history.replaceState(null, '', `/${hash}`);
    expect(launchedFromTelegram()).toBe(expected);
  });

  test('after a reload the SDK\'s sessionStorage copy counts', () => {
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppData: 'x', tgWebAppVersion: '8.0' }));
    expect(launchedFromTelegram()).toBe(true);
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({}));
    expect(launchedFromTelegram()).toBe(false);
  });
});

describe('whenTelegramSdkSettled', () => {
  test('has no time limit of its own and gives WebApp once the SDK has run', async () => {
    jest.useFakeTimers();
    const script = addSdkScript();
    let result: unknown = 'pending';
    void whenTelegramSdkSettled().then(r => { result = r; });
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(result).toBe('pending');
    sdkLoads(script, 'signed');
    await act(async () => { await Promise.resolve(); });
    expect(result).toBe(window.Telegram?.WebApp);
  });

  test('gives null when the script fails', async () => {
    const script = addSdkScript();
    const p = whenTelegramSdkSettled();
    sdkFails(script);
    await expect(p).resolves.toBeNull();
  });
});

describe('inside Telegram, no saved session', () => {
  test('SDK loads after React: loading screen (never the email screen) until it runs, then Telegram sign-in with the SDK\'s initData', async () => {
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    expect(status()).toBe('checking (sdk pending)');
    expect(fetchBodies).toEqual([]);

    await act(async () => { sdkLoads(script, 'signed-by-telegram'); });
    await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
    // The body is exactly WebApp.initData — never anything taken from the URL.
    expect(fetchBodies).toEqual([{ url: '/api/auth/telegram', body: { initData: 'signed-by-telegram' } }]);
    expect(calls).toEqual({ ready: 1, expand: 1 });
    expect(mockAuth.anonymous).toBe(0);
  });

  test('SDK already ran before React: used from the first render, one sign-in, ready() once', async () => {
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    sdkLoads(script, 'signed-early');
    render(<Probe />);
    expect(status()).toBe('checking');
    await act(async () => { mockAuth.listener?.(null); });
    await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
    expect(fetchBodies).toEqual([{ url: '/api/auth/telegram', body: { initData: 'signed-early' } }]);
    expect(calls).toEqual({ ready: 1, expand: 1 });
  });

  test('SDK fails: the Telegram retry screen (never the email screen); retry requests the SDK again and then signs in', async () => {
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    await act(async () => { sdkFails(script); });
    expect(status()).toBe('telegram_auth_error:sdk_unavailable');
    expect(fetchBodies).toEqual([]);

    await act(async () => { retry(); });
    expect(status()).toBe('checking (sdk pending)');
    const scripts = sdkScripts();
    expect(scripts).toHaveLength(2);
    expect(scripts[1].async).toBe(true);
    await act(async () => { sdkLoads(scripts[1], 'signed-after-retry'); });
    await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
    expect(fetchBodies).toEqual([{ url: '/api/auth/telegram', body: { initData: 'signed-after-retry' } }]);
    expect(mockAuth.anonymous).toBe(0);
  });

  test('SDK slow: after the wait limit the retry screen, not endless loading; when it arrives later the start continues by itself', async () => {
    jest.useFakeTimers();
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    await act(async () => { jest.advanceTimersByTime(TELEGRAM_SDK_WAIT_MS - 1); });
    expect(status()).toBe('checking (sdk pending)');
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(status()).toBe('telegram_auth_error:sdk_unavailable');
    jest.useRealTimers();

    await act(async () => { sdkLoads(script, 'signed-late'); });
    await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
    expect(fetchBodies).toEqual([{ url: '/api/auth/telegram', body: { initData: 'signed-late' } }]);
  });

  test('SDK runs with an empty initData: the email screen, as before', async () => {
    window.history.replaceState(null, '', '/#tgWebAppVersion=8.0&tgWebAppPlatform=ios');
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    await act(async () => { sdkLoads(script, ''); });
    expect(status()).toBe('unauthenticated');
    expect(fetchBodies).toEqual([]);
  });

  test.each([
    ['the server rejects the initData', { ok: false, status: 401, body: { error: 'invalid' } }, null, 'generic'],
    ['two accounts are linked to this Telegram', { ok: false, status: 409, body: { code: 'TELEGRAM_IDENTITY_CONFLICT' } }, null, 'identity_conflict'],
    ['Firebase refuses the custom token', { ok: true, status: 200, body: { token: 'custom-token' } }, new Error('auth/invalid-custom-token'), 'generic'],
  ])('Telegram sign-in error (%s): the retry screen with its reason, no anonymous account', async (_n, a, signInError, reason) => {
    answer = a as Answer;
    mockAuth.signInError = signInError as Error | null;
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    await act(async () => { sdkLoads(script, 'signed'); });
    await waitFor(() => expect(status()).toBe(`telegram_auth_error:${reason}`));
    expect(mockAuth.anonymous).toBe(0);
  });

  test.each([
    ['a new Telegram account is reported once (onboarding)', true, 1],
    ['an existing Telegram account signs in without onboarding', false, 0],
  ])('%s', async (_n, isNewUser, expected) => {
    answer = { ok: true, status: 200, body: { token: 'custom-token', isNewUser } };
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.(null); });
    await act(async () => { sdkLoads(script, 'signed'); });
    await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
    expect(newUserCallbacks).toBe(expected);
  });
});

describe('inside Telegram, saved session', () => {
  test('restored before the SDK: used as is; the SDK arriving later starts no second sign-in', async () => {
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.({ uid: 'u1' }); });
    expect(status()).toBe('authenticated (sdk pending)');
    await act(async () => { sdkLoads(script, 'signed-by-telegram'); });
    expect(status()).toBe('authenticated');
    expect(fetchBodies).toEqual([]);
    expect(calls).toEqual({ ready: 1, expand: 1 });
  });

  test('the SDK fails: the session still opens the app (as before), no sign-in attempt', async () => {
    window.history.replaceState(null, '', `/${TG_HASH}`);
    const script = addSdkScript();
    render(<Probe />);
    await act(async () => { mockAuth.listener?.({ uid: 'u1' }); });
    await act(async () => { sdkFails(script); });
    expect(status()).toBe('authenticated');
    expect(fetchBodies).toEqual([]);
  });
});

test('Telegram UI: theme, viewport height and safe areas come from the SDK when it arrives', async () => {
  window.history.replaceState(null, '', `/${TG_HASH}`);
  const script = addSdkScript();
  render(<Probe />);
  expect(screen.getByTestId('status')).toHaveAttribute('data-theme', 'dark');
  await act(async () => { sdkLoads(script, 'signed', 'light'); });
  expect(screen.getByTestId('status')).toHaveAttribute('data-theme', 'light');
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--tg-viewport-height')).toBe('640px');
  expect(style.getPropertyValue('--tg-safe-area-top')).toBe('44px');
  expect(style.getPropertyValue('--tg-safe-area-bottom')).toBe('34px');
});

test('outside Telegram nothing waits for the SDK: no session means the email screen at once', async () => {
  addSdkScript(); // still downloading
  render(<Probe />);
  await act(async () => { mockAuth.listener?.(null); });
  expect(status()).toBe('unauthenticated');
  expect(fetchBodies).toEqual([]);
});

test('outside Telegram a failing SDK changes nothing: the email screen, no retry screen', async () => {
  const script = addSdkScript();
  render(<Probe />);
  await act(async () => { sdkFails(script); });
  await act(async () => { mockAuth.listener?.(null); });
  expect(status()).toBe('unauthenticated');
});

test('raw launch parameters never reach the console', async () => {
  window.history.replaceState(null, '', `/${TG_HASH}`);
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined));
  const script = addSdkScript();
  render(<Probe />);
  await act(async () => { mockAuth.listener?.(null); });
  await act(async () => { sdkLoads(script, 'signed'); });
  await waitFor(() => expect(mockAuth.customTokens).toEqual(['custom-token']));
  const printed = JSON.stringify(spies.flatMap(s => s.mock.calls));
  expect(printed).not.toContain(LAUNCH_SECRET);
  expect(printed).not.toContain('signed');
});

describe('build freshness check: never reloads a Telegram session, even before the SDK has run', () => {
  const runCheck = async (hash: string) => {
    window.history.replaceState(null, '', `/${hash}`);
    process.env.REACT_APP_BUILD_ID = 'build-old';
    global.fetch = (async () => ({ ok: true, json: async () => ({ buildId: 'build-new' }) })) as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom: navigation not implemented
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { checkBuildFreshness } = require('../buildFreshness') as typeof import('../buildFreshness');
      checkBuildFreshness();
    });
    await new Promise(r => setTimeout(r, 20));
    delete process.env.REACT_APP_BUILD_ID;
    return window.sessionStorage.getItem('enma_reloaded_for_build');
  };

  test('inside Telegram (launch parameters in the hash, SDK not run): no reload', async () => {
    expect(await runCheck(TG_HASH)).toBeNull();
  });

  test('inside Telegram after a reload (only the SDK\'s stored copy): no reload', async () => {
    window.sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppVersion: '8.0' }));
    expect(await runCheck('')).toBeNull();
  });

  test('in a plain browser tab a stale build is still reloaded once (control)', async () => {
    expect(await runCheck('')).toBe('build-new');
  });
});
