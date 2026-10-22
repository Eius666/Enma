// Runs under Node's built-in test runner with native TypeScript type stripping
// (no build step): `node --test src/lib/__tests__/userLabels.test.ts`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveUserLabels } from '../userLabels.ts';

const base = { fallbackName: 'there' };

test('e-mail account outside Telegram', () => {
  assert.deepEqual(deriveUserLabels({ ...base, email: 'maria@example.com' }), {
    telegramName: undefined,
    displayName: 'maria',
    headerNick: 'maria',
    identityLine: 'maria@example.com',
    avatarInitials: 'MA',
  });
});

test('inside Telegram the Telegram names win for the header, the profile name for the greeting', () => {
  const tg = { first_name: 'Ann', last_name: 'Lee', username: 'annlee' };
  assert.deepEqual(deriveUserLabels({ ...base, telegramUser: tg, email: null }), {
    telegramName: 'Ann Lee',
    displayName: 'Ann Lee',
    headerNick: '@annlee',
    identityLine: 'annlee',
    avatarInitials: 'AN',
  });
  const withProfile = deriveUserLabels({ ...base, telegramUser: tg, profileDisplayName: 'Анна', email: 'a@example.com' });
  assert.equal(withProfile.displayName, 'Анна');
  assert.equal(withProfile.avatarInitials, 'АН');
  assert.equal(withProfile.headerNick, '@annlee');
  assert.equal(withProfile.identityLine, 'a@example.com');
});

test('Telegram user without a username: first name in the header, name-or-username as Telegram name', () => {
  const l = deriveUserLabels({ ...base, telegramUser: { first_name: 'Ivan' } });
  assert.equal(l.telegramName, 'Ivan');
  assert.equal(l.headerNick, 'Ivan');
  assert.equal(l.identityLine, '—');
  assert.equal(deriveUserLabels({ ...base, telegramUser: { username: 'only_nick' } }).telegramName, 'only_nick');
});

test('nothing known: the fallback greeting and an empty nick', () => {
  assert.deepEqual(deriveUserLabels({ ...base }), {
    telegramName: undefined,
    displayName: 'there',
    headerNick: '',
    identityLine: '—',
    avatarInitials: 'TH',
  });
});

test('a profile name without Telegram is used for the nick before the e-mail', () => {
  const l = deriveUserLabels({ ...base, profileDisplayName: 'Kate', email: 'k@example.com' });
  assert.equal(l.headerNick, 'Kate');
  assert.equal(l.displayName, 'Kate');
});
