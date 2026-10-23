import fs from 'fs';
import path from 'path';

// BUG-08: public/index.html opens the Firebase connections every start needs
// before the Telegram SDK script, so their DNS + TLS overlap the downloads
// instead of following them. The SDK is loaded without blocking the page and
// records when it has finished; the app waits for it inside Telegram
// (src/telegram.ts) — see telegramSdk.jest.test.ts.

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const HOSTS = ['https://securetoken.googleapis.com', 'https://identitytoolkit.googleapis.com', 'https://firestore.googleapis.com'];

test('each Firebase host is preconnected (anonymous CORS, like the SDK requests) before the Telegram script', () => {
  const sdkAt = html.indexOf('<script async src="https://telegram.org/js/telegram-web-app.js"');
  expect(sdkAt).toBeGreaterThan(0);
  for (const host of HOSTS) {
    const at = html.indexOf(`<link rel="preconnect" href="${host}" crossorigin />`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(sdkAt);
    expect(html).toContain(`<link rel="dns-prefetch" href="${host}" />`);
  }
});

test('the Telegram SDK is one async script that records loading and failure', () => {
  const tags = html.match(/<script[^>]*telegram-web-app\.js[^>]*>/g) ?? [];
  expect(tags).toEqual([
    `<script async src="https://telegram.org/js/telegram-web-app.js" onload="window.__enmaTgSdk='loaded'" onerror="window.__enmaTgSdk='failed'">`,
  ]);
  expect(html).not.toMatch(/<script[^>]*telegram-web-app\.js[^>]*defer/);
});
