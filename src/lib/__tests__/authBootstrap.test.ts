import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBootstrap } from '../authBootstrap.ts';

// See TELEGRAM_AUTOLOGIN audit — these 5 cases are the exact scenarios the
// bug report asked to be covered.

test('no existing session + valid Telegram initData -> attempts Telegram auth', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: true,
    alreadyAttemptedTelegramAuth: false,
  });
  assert.equal(decision, 'telegram_auth');
});

test('existing session -> no Telegram auth attempt (no duplicate login)', () => {
  const decision = decideBootstrap({
    hasExistingSession: true,
    telegramInitDataPresent: true,
    alreadyAttemptedTelegramAuth: false,
  });
  assert.equal(decision, 'wait');
});

test('no session + invalid/empty initData -> falls through to login screen', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
  });
  assert.equal(decision, 'unauthenticated');
});

test('no session + no initData outside Telegram -> normal browser login', () => {
  // Same shape as the "invalid initData" case on purpose: a plain browser
  // and a Telegram WebView stub with an empty initData string are
  // indistinguishable from this function's point of view, and must both
  // land on the manual login screen, never a stuck loading state.
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
  });
  assert.equal(decision, 'unauthenticated');
});

test('Telegram auth already attempted and still pending -> do not re-trigger, do not show login', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: true,
    alreadyAttemptedTelegramAuth: true,
  });
  // 'wait' is what tells App.tsx's render layer to keep the loading screen
  // up (authStatus stays 'telegram_auth') instead of rendering AuthScreen —
  // this is the exact race the TELEGRAM_AUTOLOGIN audit was about.
  assert.equal(decision, 'wait');
});
