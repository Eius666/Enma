import fs from 'fs';
import path from 'path';

// BUG-08: public/index.html opens the Firebase connections every start needs
// before the (render-blocking) Telegram SDK script, so their DNS + TLS overlap
// the downloads instead of following them. The SDK itself stays a plain,
// synchronous script: the app reads window.Telegram.WebApp on start.

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const HOSTS = ['https://securetoken.googleapis.com', 'https://identitytoolkit.googleapis.com', 'https://firestore.googleapis.com'];

test('each Firebase host is preconnected (anonymous CORS, like the SDK requests) before the Telegram script', () => {
  const sdkAt = html.indexOf('<script src="https://telegram.org/js/telegram-web-app.js"></script>');
  expect(sdkAt).toBeGreaterThan(0);
  for (const host of HOSTS) {
    const at = html.indexOf(`<link rel="preconnect" href="${host}" crossorigin />`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(sdkAt);
    expect(html).toContain(`<link rel="dns-prefetch" href="${host}" />`);
  }
});

test('the Telegram SDK is still loaded synchronously (not async/defer)', () => {
  expect(html).not.toMatch(/<script[^>]*telegram-web-app\.js[^>]*(async|defer)/);
});
