> **Naming (Stage 08):** the DEV Vercel project is actually named **`enma-l4lh`** (`prj_wwGqJR959AHCKURTDE20rRXrsb2c`). Wherever this document says `enma-dev`, read `enma-l4lh`. The project ID is what the guards check, not the name.

# ENMA — DEV environment (Stage 04, local preparation)

Status: **prepared in code, not provisioned**. No cloud resources exist yet.

## Architecture

| | PRODUCTION | DEV |
|---|---|---|
| Git | `main` (releases by approved SHA, manual) | `main` (every commit, after CI) |
| Vercel project | `enma` (`prj_sfP2…`) | new `enma-dev` |
| Domain | `enma.su` | temp `*.vercel.app` → later `enma-silk.vercel.app` (needs separate approval; today it still points at an old production deployment) |
| Firebase | `enma-4ea29` | new project (Auth, Firestore, Storage, Functions) |
| Telegram | `@YourArc_bot` | separate bot + Mini App, own `TELEGRAM_WEBHOOK_SECRET` |
| Payments | real | no Platega/TON credentials; Stars: Telegram test environment or mock |
| AI | production key | separate capped key; own `messages` collection (own Firestore) |

## Isolation guarantees (fail closed)

`api/_lib/envIsolation.js`, run when Firebase Admin initialises (every API route), refuses to start when `ENMA_ENV=dev` and:
production Firebase project, production Vercel project, bot token not matching `DEV_TELEGRAM_BOT_ID`, username `YourArc_bot`, missing/short webhook secret, missing `DEV_ALLOWED_CHAT_IDS`, production URL or Firebase id in the client config, Platega/TON credentials present.
Independently of `ENMA_ENV`: production Firebase credentials on any Vercel project other than `enma` are refused (needs Vercel system env vars exposed).
Build-time: `prebuild` runs `scripts/assertEnvIsolation.js`. Webhook: in DEV, updates from chats outside `DEV_ALLOWED_CHAT_IDS` are ignored.
Firebase CLI for DEV: `DEV_FIREBASE_PROJECT_ID=<id> node scripts/firebase-dev.js <args>` (always adds `--project`, refuses production).
Production behaviour is unchanged when `ENMA_ENV` is unset.

## CI/CD (`.github/workflows/ci.yml`)

Push to `main` → typecheck, unit tests, Firestore rules + integration tests on emulators, production build. `deploy-dev` is off until repository variable `DEV_DEPLOY_ENABLED=true`; it refuses the production Vercel project, uses only DEV secrets, and records the commit SHA. There is no production deploy job.

## Owner checklist

1. Firebase: create DEV project (Blaze only if Functions needed), enable Auth/Firestore/Storage, create service account; deploy rules/indexes with the wrapper.
2. BotFather: create the DEV bot + Mini App; give me only `DEV_TELEGRAM_BOT_ID`.
3. Vercel: create `enma-dev` (no Git auto-production), set the variables from `.env.dev.example` (Sensitive, Production scope), use a temporary URL.
4. GitHub: create environment `dev`; secret `VERCEL_DEV_TOKEN`; variables `VERCEL_DEV_ORG_ID`, `VERCEL_DEV_PROJECT_ID`; later `DEV_DEPLOY_ENABLED=true`.
5. Verify in the Vercel `enma` project that Git auto-deploy is not connected to `main`.

---

# Stage 05 — connecting Firebase DEV and Telegram DEV to Vercel `enma-dev`

Confirmed resources: Firebase `enmadev-aa7b1`; Telegram bot id `8952129105` (`@Enmadevbot`); Vercel project `enma-dev` (existence and Project ID **not yet verified** — the Vercel API was unreachable from the executor's machine; see report).

## Environment variable matrix (from code)

Scope for every row: **Production** of the `enma-dev` project (that project's only target). Secret = mark *Sensitive*.

| Variable | Source of value | Required | Secret | Used at |
|---|---|---|---|---|
| ENMA_ENV | literal `dev` | yes | no | build + runtime |
| DEV_FIREBASE_PROJECT_ID | `enmadev-aa7b1` | yes | no | build + runtime |
| DEV_TELEGRAM_BOT_ID | `8952129105` | yes | no | runtime |
| DEV_VERCEL_PROJECT_ID | `prj_wwGqJR959AHCKURTDE20rRXrsb2c` | yes | no | runtime |
| DEV_ALLOWED_CHAT_IDS | owner (tester Telegram ids) | yes | no (personal ids; Sensitive is fine) | runtime |
| TELEGRAM_BOT_TOKEN | owner, BotFather (DEV bot) | yes | **yes** | runtime |
| TELEGRAM_BOT_USERNAME | `Enmadevbot` | yes | no | runtime |
| TELEGRAM_WEBHOOK_SECRET | owner, `openssl rand -hex 32` | yes | **yes** | runtime |
| FIREBASE_SERVICE_ACCOUNT | owner, Firebase console → DEV service account | yes | **yes** | runtime |
| FIREBASE_STORAGE_BUCKET | Firebase console | no (only file storage) | no | runtime |
| REACT_APP_FIREBASE_API_KEY / AUTH_DOMAIN / PROJECT_ID / STORAGE_BUCKET / MESSAGING_SENDER_ID / APP_ID | Firebase console → DEV Web App | yes (all six) | no (public) | build |
| REACT_APP_URL | `https://enma-l4lh.vercel.app` (scheme required; validated by the guard at prebuild and server start) | yes | no | build (+ server `appUrl`) |
| REACT_APP_BOT_USERNAME | `Enmadevbot` | yes | no | build |
| REACT_APP_TONCONNECT_MANIFEST | leave unset | no | no | build |
| CRON_SECRET | owner, random | yes (guard) | **yes** | runtime |
| ADMIN_API_KEY | owner, random | yes for admin endpoints | **yes** | runtime |
| ADMIN_TELEGRAM_IDS | owner | no | no | runtime |
| PARTNER_SESSION_SECRET | owner, random | yes for partner login | **yes** | runtime |
| OPENROUTER_API_KEY (+ OPENROUTER_*_MODEL) | owner, separate capped key | no — AI unverified without it | **yes** | runtime |
| KV_REST_API_URL / KV_REST_API_TOKEN | — | no (rate limit falls back to memory) | yes | runtime |
| STARS_MINIAPP_ENABLED, STARS_CANARY_TELEGRAM_IDS | — | no (keep unset) | — | runtime |
| PLATEGA_*, TON_*, TONCENTER_*, THREADS_*, TELEGRAM_CONTENT_CHANNEL_ID, CONTENT_ADMIN_CHAT_ID | **do not set** | — | — | — |
| VERCEL_PROJECT_ID, VERCEL_ENV | injected by Vercel (system variables must be exposed in project settings) | yes (guard) | no | runtime |

Do not add `FIREBASE_SERVICE_ACCOUNT`-style values to GitHub Actions; CI uses dummy public config only.

## Guard behaviour without `VERCEL_PROJECT_ID`
On Vercel (`VERCEL_ENV` set) with `ENMA_ENV=dev` and no `VERCEL_PROJECT_ID`, the API refuses to start (`DEV_VERCEL_PROJECT_ID_UNAVAILABLE`). Fix = enable *Automatically expose System Environment Variables* in the `enma-dev` project; the check is not to be weakened.

## Local DEV builds
`prebuild` merges `.env.production.local`, `.env.local`, `.env.production`, `.env` (as CRA does) before checking. A machine whose `.env.local` holds production values will therefore refuse a DEV build. Build DEV only in Vercel/CI, or in a clean copy without those files.

## First connection sequence (nothing is executed until the owner approves)
1. Firebase `enmadev-aa7b1`: enable Authentication (provider for custom tokens needs no extra provider) and Firestore (Native mode); create a Web App and a service-account key; add the temporary `enma-dev` domain to Authentication → Authorized domains.
2. `DEV_FIREBASE_PROJECT_ID=enmadev-aa7b1 npm run dev:firebase:deploy-firestore` (rules + indexes only; wrapper adds `--project`, refuses production, refuses functions/hosting).
3. Vercel `enma-dev`: no Git repository connected; enable system env vars; set the matrix above; **first deploy by the owner's explicit approval** (CLI from a clean copy, or CI once `DEV_DEPLOY_ENABLED=true`).
4. Readiness check **before** the webhook: `GET <dev-url>/api/payment/version` (build id) and a `POST` without the secret header to `/api/telegram/webhook` → expect `401` (this proves the deployment has the DEV secret and the handler is live).
5. `setWebhook` for `@Enmadevbot` with `url=<dev-url>/api/telegram/webhook`, `secret_token=<DEV secret>`, no `drop_pending_updates`; then `getWebhookInfo`.
6. BotFather (DEV bot): set Mini App / menu button URL to the temporary `enma-dev` URL.
7. Smoke tests: see the Stage 05 report (§G).

---

# Stage 06 — Git integration, Vercel CLI safety, first-deploy readiness

## Git → Vercel auto-deploy (critical)
GitHub's public Deployments API for `Eius666/Enma` shows **241 `Production` deployments created by `vercel[bot]`** (2025-11-26 … 2026-10-05), i.e. the production project `enma` has been deploying from pushes to `main`. A push of the 26 local commits would therefore very probably publish `e720ef7` to `enma.su`. A second Vercel project, `enma-l4lh`, also reports a (failing) status on `b69ed3e`; `enma-dev` is connected too (owner-confirmed). **No push to `main` until the owner has confirmed in the Dashboard that auto-deploy is off for `enma`, `enma-dev` and `enma-l4lh`.**

Options (owner decides; nothing applied):
1. Dashboard → project → Settings → Git → **Disconnect** (cleanest; verify no deployment depends on it — existing deployments keep working, CLI deploys unaffected).
2. Dashboard → Settings → Git → *Ignored Build Step* → "Don't build anything" (`exit 0`), keeps the link.
3. `vercel.json`: `{ "git": { "deploymentEnabled": false } }`. Shared by all projects reading this repo and community reports say it is not always honoured (branch tracking); **not** a sole barrier. Not applied.

Target model: GitHub Actions (`ci.yml`, tests first) → controlled DEV deploy; production only by explicit manual approval.

## Verifying `VERCEL_PROJECT_ID`
Vercel docs list it as a system variable available at build and runtime (retrieved via search; the docs site itself blocked this machine). Safe end-to-end verification: the guard refuses to start unless `VERCEL_PROJECT_ID == DEV_VERCEL_PROJECT_ID`; after the first deploy, `GET /api/payment/version` loads Firebase Admin → HTTP 200 proves the variable is present and correct, an HTTP 500 with `ENV_ISOLATION:…` in the logs proves the guard is working and the variable is missing/wrong. No fail-closed check was relaxed.

## CLI safety
- `node scripts/vercel-dev.js …` (needs `DEV_VERCEL_PROJECT_ID`, `VERCEL_ORG_ID=team_…`): target from env only, refuses the production project, directories with `.vercel` or `.env*`, and non-allow-listed subcommands (no `alias`, `env rm`, `--scope`). `--print-only` shows the command.
- `node scripts/firebase-dev.js … [--print-only]`: always `--project $DEV_FIREBASE_PROJECT_ID`, never `enma-4ea29`, `deploy` only for `firestore:*`.
- Run Vercel CLI only from a clean copy (no `.vercel`, no `.env*`); the working directory is linked to production.

## Firebase Admin credentials
Do not paste the JSON in a terminal. Options: (a) Vercel Dashboard → `enma-dev` → Environment Variables → value field, mark *Sensitive*; (b) `vercel env add FIREBASE_SERVICE_ACCOUNT` reading the file on stdin (`< key.json`, nothing echoed; run from a clean directory). Delete the downloaded key file afterwards (or keep it only in the password manager). Never commit it, never place it in GitHub Actions.

---

# Stage 07 — first DEV deployment procedure (NOT executed; each step needs owner approval)

Blocking prerequisites: [docs/GIT_AUTODEPLOY_CHECKLIST.md](GIT_AUTODEPLOY_CHECKLIST.md) confirmed for `enma`, `enma-dev` (and `enma-l4lh` identified); all variables from the matrix entered in `enma-dev`; Authentication enabled in `enmadev-aa7b1`; Vercel reachable (Security Checkpoint not blocking — never bypass it).

## 1. Local pre-flight (no network)
Keep a private mirror of the DEV values OUTSIDE the repo (`chmod 600 ~/enma-dev.env`, same names as `.env.dev.example`, plus the real secrets):
```
node scripts/dev-preflight.js --env-file ~/enma-dev.env
```
Prints PASS/FAIL names only. Checks: pinned DEV Vercel project / Firebase project / bot id; token belongs to the DEV bot; service-account `project_id` is `enmadev-aa7b1`; webhook secret ≥ 32 chars; no Platega/TON/Threads/Stars/channel variables; production values refused; the fail-closed guards are exercised (production Firebase and production Vercel project must be *refused*). Must end with "all checks passed".

## 2. Firebase rules + indexes (dry check, then deploy on approval)
```
DEV_FIREBASE_PROJECT_ID=enmadev-aa7b1 node scripts/firebase-dev.js deploy --only firestore:rules,firestore:indexes --print-only
# prints: firebase deploy --only firestore:rules,firestore:indexes --project enmadev-aa7b1
# on approval, drop --print-only
```
Firebase CLI has no deploy dry-run; the rules are covered by the 38-test emulator suite (`npm run test:rules`).

## 3. Deploy = push to `main` (DEV Vercel project `enma-l4lh`, Git Integration) — on approval
Model chosen by the owner: `git push main` → Vercel Git Integration of **`enma-l4lh`** (`prj_wwGqJR959AHCKURTDE20rRXrsb2c`) deploys DEV. GitHub Actions (`ci.yml`) only verifies; it has no deploy job and no secrets, so there is a single DEV deployer. `scripts/vercel-dev.js` is read-only (`env ls`, `inspect`, `logs`…) and refuses `deploy`.
Before the push (all must be true):
- `enma` (production project): Git disconnected — the owner's statement is on record; independent proof is the Dashboard screenshot (Settings → Git: "Connect Git Repository" empty). The executor cannot read this (Vercel API blocked).
- `enma-l4lh`: Production Branch = `main`; Root Directory empty; Framework = Create React App; Node.js version compatible with `package.json` engines; *Automatically expose System Environment Variables* ON; **all variables from the matrix already entered** (otherwise the first auto-build runs with missing config — it fails closed, but do not rely on that).
- Commit + push approved explicitly by the owner (never done by the executor on its own).
The push publishes 26 commits plus the SEC-12/DEV commit. Nothing is built in production because no production project is connected.

## 4. Verify the deployment (before any webhook)
- `GET https://<dev-url>/api/payment/version` → 200 (proves `VERCEL_PROJECT_ID == DEV_VERCEL_PROJECT_ID` and Firebase Admin initialised with the DEV project). 500 + `ENV_ISOLATION:…` in the runtime logs → fix configuration; do not weaken the guard.
- `POST https://<dev-url>/api/telegram/webhook` without the secret header → **401** (SEC-12 live). 503 → `TELEGRAM_WEBHOOK_SECRET` missing.
- Open the temporary URL in a browser: the Auth screen links to `t.me/Enmadevbot`.

## 5. Webhook (separate approval)
`setWebhook` for the DEV bot only: `url=https://<dev-url>/api/telegram/webhook`, `secret_token=<DEV secret>`, no `drop_pending_updates`; then `getWebhookInfo`; then BotFather Mini App/menu URL.

---

# Stage DEV-09 — cron consolidation (Hobby function cap)

Vercel rejected the first DEV deployments with `exceeded_serverless_functions_per_deployment` (Hobby: max 12 Functions; the Stage-08 builder counts the Edge middleware too). The four cron handlers now share **one** Function:

- `api/cron/[job].js` routes `/api/cron/content-plan | content-publish | maintenance | insights` (URLs, methods, `CRON_SECRET` checks and responses unchanged — the handlers themselves are untouched and live in `api/_cron/`, an underscore directory that Vercel does not deploy).
- Job comes from the URL path, exact-match allowlist, literal `require()` per job, unknown job → 404.
- `vercel.json`: the four `functions` entries became `"api/cron/[job].js": { "maxDuration": 30 }` (same 30 s as before).
- Function count: 12 Node.js entry points → **9** (+ the Edge middleware = 10 outputs).
- No scheduler is configured for these routes in this repository (no `crons`, GitHub workflow disabled); whoever triggers them externally keeps using the same URLs.

---

# Stage DEV-13A — URL validation and "known DEV project must be dev"

- `REACT_APP_URL` in DEV must be an absolute **https** URL whose origin is exactly `https://enma-l4lh.vercel.app` (optional trailing `/`; no credentials, query, fragment or path). Production hosts (`enma.su`, `www.enma.su`, `enma-silk.vercel.app` and their subdomains) are refused with `DEV_URL_IS_PROD`. Checked at **prebuild** (`scripts/assertEnvIsolation.js`) and at **server start** (Firebase Admin init). Incident that motivated it: the value was entered as `enma-l4lh.vercel.app`, baked into the bundle, and produced invalid Telegram buttons.
- A deployment on Vercel project `prj_wwGqJR959AHCKURTDE20rRXrsb2c` (DEV) with `ENMA_ENV` missing/not `dev` is refused (`DEV_PROJECT_WITHOUT_ENMA_ENV_DEV`) at prebuild and at server start, so forgetting `ENMA_ENV=dev` can no longer switch the DEV guards off.
- Production (`ENMA_ENV` unset, other projects) is not affected by either rule.
