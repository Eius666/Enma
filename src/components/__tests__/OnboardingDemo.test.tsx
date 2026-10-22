import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import OnboardingDemo from '../OnboardingDemo';
import type { Subscription } from '../../subscription';

// BUG-07: the free-trial offer in the AI preview is shown only when the
// server would grant a trial (no subscriptions/{uid} document). Documents are
// shaped the way the server writes them.

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// api/auth/telegram.js → buildTrialSubscription: the trial every new Telegram
// user gets at sign-up (the only moment this preview is shown).
const registrationTrial = (): Subscription => ({
  plan: 'free', trialPlan: 'premium', period: 'month', status: 'active', paymentMethod: 'trial',
  startDate: iso(Date.now()), endDate: iso(Date.now() + 7 * DAY - 1000), endDateMs: Date.now() + 7 * DAY - 1000,
  trialEndDate: iso(Date.now() + 7 * DAY - 1000),
} as unknown as Subscription);
const paidPremium = (): Subscription => ({
  plan: 'premium', status: 'active', period: 'month', paymentMethod: 'sbp',
  startDate: iso(Date.now() - DAY), endDate: iso(Date.now() + 20 * DAY), endDateMs: Date.now() + 20 * DAY,
} as unknown as Subscription);
const expiredPaid = (): Subscription => ({
  plan: 'pro', status: 'active', period: 'month', paymentMethod: 'sbp',
  startDate: iso(Date.now() - 40 * DAY), endDate: iso(Date.now() - DAY), endDateMs: Date.now() - DAY,
} as unknown as Subscription);

const CTA = 'Попробовать на моих данных — 7 дней бесплатно';

function showDemo(subscription: Subscription | null, subscriptionLoaded = true) {
  const spies = { onStartTrial: jest.fn(), onDismiss: jest.fn() };
  render(<OnboardingDemo language="ru" subscription={subscription} subscriptionLoaded={subscriptionLoaded} {...spies} />);
  return spies;
}

test('a new user with the sign-up trial is not offered a trial: the trial is shown as active', () => {
  const spies = showDemo(registrationTrial());
  expect(screen.queryByRole('button', { name: CTA })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Пробный период Premium активен — осталось дней: 7');
  fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
  expect(spies.onDismiss).toHaveBeenCalledTimes(1);
  expect(spies.onStartTrial).not.toHaveBeenCalled();
});

test('a paid Premium user is not offered a trial', () => {
  showDemo(paidPremium());
  expect(screen.queryByRole('button', { name: CTA })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Premium уже активен');
});

test('a past subscription (no active plan) gets no offer either — the server would refuse it', () => {
  showDemo(expiredPaid());
  expect(screen.queryByRole('button', { name: CTA })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

test('while the subscription is still loading nothing about plans or trials is shown', () => {
  showDemo(null, false);
  expect(screen.queryByRole('button', { name: CTA })).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Понятно' })).toBeTruthy();
});

test('with no subscription at all the offer is shown and keeps its action', () => {
  const spies = showDemo(null, true);
  fireEvent.click(screen.getByRole('button', { name: CTA }));
  expect(spies.onStartTrial).toHaveBeenCalledTimes(1);
  expect(spies.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Пропустить' }));
  expect(spies.onDismiss).toHaveBeenCalledTimes(1);
});

test('the preview is a modal dialog with a close button; the analysis still expands', () => {
  const spies = showDemo(registrationTrial());
  expect(screen.getByRole('dialog', { name: 'Предпросмотр AI-анализа' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Показать AI-анализ' }));
  expect(screen.getByText('В этом месяце вы потратили 32% дохода на еду и развлечения.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(spies.onDismiss).toHaveBeenCalledTimes(1);
});
