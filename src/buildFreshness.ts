// Detects a stale, cached frontend bundle (Telegram WebView / long-lived
// browser tab serving an old app shell despite a newer one being live —
// confirmed NOT a Service Worker, which this codebase has never registered)
// and forces exactly one real network reload to fix it, instead of relying
// on the browser/WebView to decide to revalidate on its own.
//
// Safe by construction:
//  - /api/payment/version is a brand-new endpoint with Cache-Control:
//    no-store, so there is no possible stale cached copy of it to begin
//    with — the first-ever request for this exact URL always hits the
//    network. It lives on the existing payment function (not its own
//    api/version.js) — Vercel's Hobby plan caps a deployment at 12
//    Serverless Functions, and a dedicated function pushed this project
//    over that limit.
//  - A reload is only ever forced once per (tab session, stale build) pair
//    — the sessionStorage guard prevents any reload loop.
//  - The new URL keeps every existing query param (Telegram's start_param/
//    startapp/tgWebApp* included) and only adds `_v`.
//  - Never blocks first paint — this runs as a fire-and-forget check.

const BUILD_ID = process.env.REACT_APP_BUILD_ID || 'dev';
const RELOAD_GUARD_KEY = 'enma_reloaded_for_build';

declare global {
  interface Window { __ENMA_BUILD_ID__?: string; }
}
if (typeof window !== 'undefined') {
  window.__ENMA_BUILD_ID__ = BUILD_ID;
}

export function checkBuildFreshness(): void {
  // No build id was baked in (local dev server via `npm start`) — nothing
  // meaningful to compare, and dev builds aren't what gets cached anyway.
  if (BUILD_ID === 'dev') return;

  fetch('/api/payment/version', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d: { buildId?: string }) => {
      if (!d?.buildId || d.buildId === BUILD_ID) return;

      let alreadyReloadedFor: string | null = null;
      try { alreadyReloadedFor = sessionStorage.getItem(RELOAD_GUARD_KEY); } catch { /* ignore */ }
      if (alreadyReloadedFor === d.buildId) return; // already tried reloading for this exact server build this session

      try { sessionStorage.setItem(RELOAD_GUARD_KEY, d.buildId); } catch { /* ignore */ }

      const url = new URL(window.location.href);
      url.searchParams.set('_v', d.buildId);
      window.location.replace(url.toString());
    })
    .catch(() => { /* never let this check break the app */ });
}

// This codebase has never registered a Service Worker (verified across the
// full git history), so this is a no-op in the normal case — cheap defensive
// cleanup in case one was ever registered some other way. Only ever touches
// cache names that are unambiguously Enma's own.
export function unregisterStaleServiceWorkers(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => { registrations.forEach((r) => r.unregister()); })
      .catch(() => {});
  }

  if ('caches' in window) {
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.toLowerCase().startsWith('enma')).map((k) => caches.delete(k))
      ))
      .catch(() => {});
  }
}
