# GitHub Pages Deployment Guide

This guide walks through the full publishing flow for Enma, from local setup to verifying the public URL. If you only need the step-by-step commands, jump to the [`GitHub Pages Quick-Publish Checklist`](README.md#github-pages-quick-publish-checklist).

## Prerequisites

- Node.js 18+ with npm.
- Access to the `main` branch of the `Eius666/Enma` repository.
- GitHub Pages already configured to serve from the `gh-pages` branch (auto-managed by the deploy script).

## 1. Install Dependencies

```bash
npm install --no-progress
```

The `--no-progress` flag keeps CI logs quiet and speeds up installation when you are redeploying frequently.

## 2. Validate the Build Locally

```bash
npm run build
```

- Output lands in `build/`.
- Check the console for TypeScript errors or linting warnings. Fix anything before deploying.

## 3. Smoke Test the Production Bundle (Optional but Recommended)

```bash
npm install -g serve
serve -s build
```

Navigate to `http://localhost:3000` (or the port shown in the console) and click through the calendar, notes, and finance tabs to confirm the UI renders correctly.

## 4. Publish to GitHub Pages

```bash
npm run deploy
```

The script executes the following:

1. Rebuilds the project (via the `predeploy` hook).
2. Pushes the `build/` directory to the `gh-pages` branch.
3. Keeps the `homepage` field in `package.json` aligned with `https://eius666.github.io/Enma`.

## 5. Confirm the Public Site

- Visit https://eius666.github.io/Enma/.
- Hard refresh (Shift+Reload) to bust the cache.
- Open the browser console and verify the service worker logs show the current timestamp.
- Cross-check the publish time with the latest commit on the `gh-pages` branch.

## Troubleshooting

- **Stale Assets** – Clear the site data in DevTools or bump the build by editing `package.json` to invalidate caches.
- **404 Page** – Ensure the `homepage` field matches the repository slug and that GitHub Pages is pointed at the `gh-pages` branch.
- **Build Failures** – Run `npm test` locally to surface failing component tests, then retry `npm run build`.

Need only the commands? Head back to the [`GitHub Pages Quick-Publish Checklist`](README.md#github-pages-quick-publish-checklist) in the README and follow the condensed flow.
