# Enma Deploy Checklist

## Firestore Security Rules

- [ ] `firebase deploy --only firestore:rules`
- [ ] Verify deploy succeeds with no warnings: `firebase deploy --only firestore:rules --dry-run`
- [ ] Confirm `aiUsage` write is blocked from client (attempt a client-side write — expect Permission denied)
- [ ] Confirm `freeUsage` reads require auth (unauthenticated access — expect Permission denied)
- [ ] Confirm Free habit limit blocks create #4 (Firestore Rules Simulator in Firebase Console)

## Backend Environment Variables (Vercel)

- [ ] `vercel env add OPENAI_API_KEY` (or `OPENROUTER_API_KEY` if using OpenRouter)
- [ ] `vercel env add PLATEGA_SECRET` — must match what Platega sends in `X-Platega-Signature`
- [ ] `vercel env add TELEGRAM_BOT_TOKEN`
- [ ] `vercel env add FIREBASE_SERVICE_ACCOUNT` (JSON stringified)
- [ ] `vercel env add FIREBASE_DATABASE_URL`
- [ ] Confirm none of the above appear in `src/` (grep passes: no OPENAI_API_KEY, no PLATEGA_SECRET)

## API Routes Smoke Tests

```bash
# AI analyze (replace TOKEN with a valid Firebase ID token)
curl -X POST https://your-app.vercel.app/api/ai/analyze \
  -H "Content-Type: application/json" \
  -d '{"userId":"TEST_UID","transactions":[],"month":"2026-08"}'
# Expected: 429 plan_restricted (free user) or JSON analysis

# Image generation (premium only)
curl -X POST https://your-app.vercel.app/api/ai/image \
  -H "Content-Type: application/json" \
  -d '{"userId":"TEST_UID","prompt":"a cat"}'
# Expected: 429 plan_restricted

# Verify rate limiting (call twice within 10s)
# Expected: second call returns 429 rate_limit with retryAfterMs
```

## Payment Flows

- [ ] SBP: create a test payment for 1 RUB, verify callback receives correct signature
- [ ] Telegram Stars: verify `/api/payment/create` returns correct `invoice_link`
- [ ] TON: connect a test wallet, initiate payment, verify `/api/ton/verify` sets subscription
- [ ] Confirm `endDateMs` is written alongside `endDate` in all 4 payment endpoints:
  - `api/payment/callback.js`
  - `api/payment/trial.js`
  - `api/auth/telegram.js`
  - `api/ton/verify.js`

## Trial Flow

- [ ] New user registers → `trialUsed === false` → OnboardingDemo shown → "Start trial" → subscription created with `trialPlan: 'premium'`, `trialEndDate: now+7d`
- [ ] During trial: header badge shows `TRIAL Xд` / `TRIAL Xd`, limits are Premium
- [ ] After trial end: `trialJustExpired` banner appears, badge disappears, limits revert to Free
- [ ] Users with data created during trial retain all documents (habits, notes, etc.)
- [ ] Creating a 4th habit after trial end → blocked by Firestore Rule + client Paywall

## Subscription Lifecycle

- [ ] Pro upgrade → `aiUsage.textRequests` limit raises to 20, images remain 0
- [ ] Premium upgrade → all AI limits raise, `aiUsage` displayed in Settings in real-time
- [ ] Premium → downgrade (cancel) → access until `endDate`, then Free limits apply
- [ ] `calculateProratedEndDate` used in mid-cycle upgrade → extra days credited correctly
- [ ] Expired subscription stored (not null) → SubscriptionPanel shows "Renew" prompt

## Build & Lint

- [ ] `npm run lint` — zero warnings, zero errors
- [ ] `npm run build` — success, gzip JS bundle < 400 kB (current: 346.8 kB)
- [ ] No `console.log` in `src/` (only `console.warn` / `console.error` for failures)
- [ ] No `any` types in new code (`usageCounters.ts`, `openai.ts`, `subscription.ts`)

## Known Limitations (acceptable for initial launch)

- DALL-E generated images are returned as temporary OpenAI URLs (~1 hour TTL). They are
  NOT persisted to Firebase Storage. Users who try to re-open a note with an AI image
  after 1 hour will see a broken image. Fix: add server-side image proxy + Storage upload
  in `api/ai/[action].js` `handleImage`.

- `freeUsage` counters are written by the client via Firestore transactions (atomic),
  not the Admin SDK. The Firestore Rule enforces `userId == request.auth.uid` on writes,
  so cross-user manipulation is impossible, but a determined user could theoretically
  craft writes that bypass the limit check (e.g., write `habitCount: 0` directly).
  Mitigation: also enforce limits server-side in the editors' save endpoints if this
  becomes a concern.

- `any` types in pre-existing hooks (`useHabits.ts`, `useTransactions.ts`, etc.) are
  carryovers from before this feature set. Not introduced by this implementation.
