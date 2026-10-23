import fs from 'fs';
import path from 'path';
import { createT } from '../i18n/createT';

// The sign-in screen's texts come from src/i18n/locales via createT, which
// falls back to the key itself when a key is missing. Every key the screen
// asks for must exist in both languages, and only literal keys may be used
// (the dictionaries hold just what the screen needs).

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'workspaces', 'AuthScreen.tsx'), 'utf8');
const keys = Array.from(new Set(Array.from(source.matchAll(/\bt\('([A-Za-z.]+)'/g), m => m[1])));

test('the sign-in screen only uses literal keys', () => {
  expect(keys.length).toBeGreaterThan(20);
  expect(source).not.toMatch(/\bt\((?!')/);
});

test.each(['ru', 'en'] as const)('every sign-in key exists in %s', (lang) => {
  const t = createT(lang);
  const missing = keys.filter(k => t(k) === k);
  expect(missing).toEqual([]);
});
