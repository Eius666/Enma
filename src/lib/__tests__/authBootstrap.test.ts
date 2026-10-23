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

// The Telegram SDK loads without blocking the page. Inside Telegram, until it
// has run, initData is unknown: its absence must not be read as "no Telegram".

test('inside Telegram, SDK not run yet, no session -> wait (never the login screen)', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkPending: true,
  });
  assert.equal(decision, 'wait');
});

test('inside Telegram, SDK not run yet, session restored -> the session is used as before', () => {
  const decision = decideBootstrap({
    hasExistingSession: true,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkPending: true,
  });
  assert.equal(decision, 'wait');
});

test('SDK has run with initData, no session -> Telegram auth, exactly as before', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: true,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkPending: false,
  });
  assert.equal(decision, 'telegram_auth');
});

test('SDK settled without initData (outside Telegram, or an empty initData), no session -> login screen, exactly as before', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkPending: false,
  });
  assert.equal(decision, 'unauthenticated');
});

test('inside Telegram, SDK failed (or too slow), no session -> the Telegram retry screen, not the login screen', () => {
  const decision = decideBootstrap({
    hasExistingSession: false,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkPending: false,
    telegramSdkFailed: true,
  });
  assert.equal(decision, 'telegram_sdk_error');
});

test('inside Telegram, SDK failed, session restored -> the session is used (no error screen)', () => {
  const decision = decideBootstrap({
    hasExistingSession: true,
    telegramInitDataPresent: false,
    alreadyAttemptedTelegramAuth: false,
    telegramSdkFailed: true,
  });
  assert.equal(decision, 'wait');
});
