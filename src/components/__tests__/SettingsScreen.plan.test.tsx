import React from 'react';
import { render, screen, act } from '@testing-library/react';
import type { User } from 'firebase/auth';
import SettingsScreen from '../SettingsScreen';
import type { Subscription } from '../../subscription';

// BUG-09: how Settings names the plan. Documents are shaped the way the
// server writes them; the purchase flow and the app's own limits must stay as
// they were (only the names change).

jest.mock('@tonconnect/ui-react', () => ({
  useTonConnectUI: () => [{ openModal: () => {}, disconnect: () => {}, sendTransaction: async () => ({}) }],
  useTonAddress: () => '',
  useTonWallet: () => null,
}));

jest.mock('../../firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: async () => ({ exists: () => true, data: () => ({ trialUsed: true }) }),
  setDoc: async () => undefined,
  serverTimestamp: () => 'TS',
}));

const mockUsage = { ai: [] as unknown[], free: [] as unknown[] };
jest.mock('../../lib/usageCounters', () => ({
  subscribeAiUsage: (uid: unknown) => { mockUsage.ai.push(uid); return () => {}; },
  subscribeFreeUsage: (uid: unknown) => { mockUsage.free.push(uid); return () => {}; },
}));

jest.mock('../../lib/fetchWithTimeout', () => ({
  fetchWithTimeout: async () => ({ json: async () => ({ ok: false }) }),
}));

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// api/_lib/subscription/plan.js → buildTrialSubscription (registration).
const registrationTrial = (daysLeft: number): Subscription => {
  const end = Date.now() + daysLeft * DAY - 1000;
  return {
    id: 'trial_u1', userId: 'u1', plan: 'free', trialPlan: 'premium', period: 'month', status: 'active',
    startDate: iso(Date.now() - DAY), endDate: iso(end), endDateMs: end, trialEndDate: iso(end),
    paymentMethod: 'trial', createdAt: iso(Date.now() - DAY), updatedAt: iso(Date.now() - DAY),
  } as unknown as Subscription;
};
// _lib/subscription/extend.js (SBP, balance, Stars) merged over the document.
const paidOver = (base: Subscription | null, plan: 'pro' | 'premium', daysLeft: number): Subscription => ({
  ...(base ?? { userId: 'u1', startDate: iso(Date.now() - DAY) }),
  plan, period: 'month', status: 'active',
  endDate: iso(Date.now() + daysLeft * DAY), endDateMs: Date.now() + daysLeft * DAY, lastPaymentMethod: 'sbp',
} as unknown as Subscription);

const user = { uid: 'u1', email: 'u1@example.com', getIdToken: async () => 'token' } as unknown as User;

async function showSettings(subscription: Subscription | null) {
  render(
    <SettingsScreen
      language="ru" theme="dark" currency="RUB" user={user} subscription={subscription} subscriptionLoaded
      ratesStatus="idle" ratesUpdatedAt={null} banks={[]}
      onLanguageChange={jest.fn()} onCurrencyChange={jest.fn()} onThemeToggle={jest.fn()} onRefreshRates={jest.fn()}
      onSubscriptionChange={jest.fn()} onBanksChange={jest.fn()} onSignOut={jest.fn()}
    />,
  );
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const planToggle = (name: 'Free' | 'Pro' | 'Premium') =>
  screen.getAllByRole('button', { name }).find(b => /plan-toggle-btn/.test(b.className))!;
const DOT = '<span class="subscription-panel__plan-toggle-dot"></span>';

beforeEach(() => { mockUsage.ai = []; mockUsage.free = []; });

test('a running trial: "Premium — пробный период" with the days left', async () => {
  await showSettings(registrationTrial(6));
  expect(screen.getByText('Enma Premium')).toBeTruthy();
  expect(screen.getByText('Premium — пробный период · осталось 6 дней').className).toMatch(/sett-row__value--trial/);
  expect(screen.getByText(/^Пробный период до /)).toBeTruthy();
  expect(screen.queryByText('Вы уже на максимальном тарифе!')).toBeNull();
  expect(planToggle('Premium')).toContainHTML(DOT);
  // What the trial allows is unchanged: Premium AI meters, no free-plan meters.
  expect(mockUsage.ai).toContain('u1');
  expect(mockUsage.free).toEqual([]);
});

test('day words of the trial line', async () => {
  await showSettings(registrationTrial(1));
  expect(screen.getByText('Premium — пробный период · осталось 1 день')).toBeTruthy();
});

test('a paid Premium plan reads Premium, active', async () => {
  await showSettings(paidOver(null, 'premium', 20));
  expect(screen.getByText('Enma Premium')).toBeTruthy();
  expect(screen.getByText('Premium — Активна').className).not.toMatch(/--trial/);
  expect(screen.getByText(/^Активна до /)).toBeTruthy();
  expect(screen.getByText('Вы уже на максимальном тарифе!')).toBeTruthy();
});

test('a Pro plan paid for during the trial is shown as Pro, not as the trial', async () => {
  await showSettings(paidOver(registrationTrial(3), 'pro', 33));
  expect(screen.getByText('Enma Pro')).toBeTruthy();
  expect(screen.getByText('Pro — Активна')).toBeTruthy();
  expect(screen.queryByText(/пробный период/)).toBeNull();
  expect(planToggle('Pro')).toContainHTML(DOT);
  expect(planToggle('Premium')).not.toContainHTML(DOT);
  expect(mockUsage.ai).toContain('u1');
});

test('an ended trial is not shown as a subscription', async () => {
  await showSettings(registrationTrial(-1));
  expect(screen.getByText('Бесплатный тариф')).toBeTruthy();
  expect(screen.queryByText(/пробный период|Активна до/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Управление подпиской' })).toBeNull();
  expect(mockUsage.free).toContain('u1');
  expect(mockUsage.ai).toEqual([]);
});
