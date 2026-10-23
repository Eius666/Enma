# Enma

Personal organizer for Telegram: day plan, habits, notes, finances and an AI
assistant. A Telegram Mini App (React, Create React App) with a serverless API
on Vercel and Firebase (Auth, Firestore).

## Layout

| Path | What it is |
|---|---|
| `src/` | the Mini App (React + TypeScript); `src/admin/` — the admin panel (`/admin`) |
| `api/` | Vercel serverless functions; shared server code in `api/_lib/` |
| `functions/` | Firebase Functions (reminder scheduling) |
| `firestore.rules`, `firestore.indexes.json` | Firestore security rules and indexes |
| `firestore-tests/` | rules and data-protocol tests against the Firestore emulator |
| `scripts/` | build helpers, DEV tooling and owner-run maintenance scripts |
| `public/` | static pages and assets (privacy, terms, partners, manifests) |
| `finance-bot/` | a separate Express service with its own tooling — not part of the app build |

## Local development

Requires Node.js 24 and the Firebase CLI (for the emulator suites).

```bash
npm ci
npm start                 # dev server
npm run typecheck
npm run lint
npm run test:unit         # node --test (no network, no emulator)
npm run test:ui           # jest + jsdom
npm run test:rules        # Firestore emulator; see package.json for the other *-integration suites
npm run test:brain        # AI assistant regression scenarios
npm run build             # production build (postbuild adds startup preload hints)
```

Environment variables are described in `.env.example` (and `.env.dev.example`
for the DEV environment). Never commit real values.

## Environments and releases

- **DEV** is built and deployed automatically from `main` by the Vercel Git
  integration after CI. See `docs/DEV_ENVIRONMENT.md` and
  `docs/GIT_AUTODEPLOY_CHECKLIST.md`.
- **Production** releases are made separately by the owner from an approved
  commit; nothing in this repository deploys to production.
- CI (`.github/workflows/ci.yml`) runs type checks, unit, UI, emulator and
  build checks on every push; it has no deployment step.

Manual test matrix for subscriptions: `TESTING.md`. Firestore rules release
checklist: `DEPLOY_CHECKLIST.md`.
