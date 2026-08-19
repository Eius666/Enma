# Subscription System — Manual Test Matrix

## Free Plan Limits

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 1 | Task daily limit hit | Free user creates 5 tasks today, tries to create 6th | `incrementFreeUsageAtomic` returns `allowed: false`; Paywall modal shown; task NOT created; Firestore Rule blocks if bypassed |
| 2 | Task limit resets next day | Same user opens DayTaskEditor the following UTC day | Counter reads 0 (window rolls over); 6th task allowed |
| 3 | Transaction monthly limit | Free user creates 30 transactions in the same month, tries 31st | Paywall shown; `FinanceEditor` blocked; Firestore Rule blocks write |
| 4 | Transaction limit resets | Same user on the 1st of next month | Counter resets; 31st transaction allowed |
| 5 | Habit limit (total) | Free user creates 3 habits, tries to create 4th | Paywall shown; `HabitEditor` blocked |
| 6 | Note limit (total) | Free user creates 10 notes, tries to create 11th | Auto-save hits limit; Paywall shown; `limitPassedRef` prevents double-increment |
| 7 | Near-80% banner | Free user has 4/5 tasks today | `LimitBanner` appears above editor ("4/5 tasks today"); no Paywall yet |
| 8 | Settings free usage display | Free user opens Settings | "Free plan usage" card shows progress bars for all 4 counters in real-time |

## Pro Plan

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 9 | AI text limit | Pro user makes 20 AI analyze requests in the same month, tries 21st | `/api/ai/analyze` returns 429 `monthly_limit`; frontend catches `AiLimitError`; toast shown |
| 10 | AI image blocked | Pro user tries to generate an image | `/api/ai/image` returns 429 `plan_restricted` (image limit = 0 for Pro); Paywall with "Upgrade to Premium" |
| 11 | AI request rate limit | Pro user makes 2 AI text requests within 10 seconds | Second call returns 429 `rate_limit` with `retryAfterMs: 10000` |
| 12 | No free limits | Pro user tries to create 10+ habits | No Paywall; `isFree = false`; `incrementFreeUsageAtomic` never called |

## Premium Plan

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 13 | AI image monthly limit | Premium user generates 30 images, tries 31st | 429 `monthly_limit`; `used: 30`, `limit: 30` |
| 14 | AI text limit | Premium user makes 100 text requests, tries 101st | 429 `monthly_limit` |
| 15 | PDF report limit | Premium user generates 10 reports, tries 11th | 429 `monthly_limit` |
| 16 | AI image rate limit | Two image requests within 30 seconds | Second returns 429 `rate_limit`, `retryAfterMs: 30000` |

## Trial Flow

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 17 | During trial — Premium features | New user starts trial, tries AI image | Plan resolved as `premium`; AI limits apply; image generated |
| 18 | During trial — habit creation | User on Premium trial creates 8 habits | All 8 created; `isFree = false` in `HabitEditor`; no counter increment |
| 19 | Trial expired — existing data | User's trial ends; opens Habits list | All 8 habits visible; no data deleted |
| 20 | Trial expired — new habit | User tries to create 9th habit after trial | `trialJustExpired` banner shown; `isFree = true`; habitCount is 0 (not used during trial); 9th habit IS allowed until Free limit of 3 is hit |
| 21 | Trial expired badge | Day after trial ends | Header avatar badge disappears; plan label removed |
| 22 | Trial banner prompt | `trialJustExpired === true` | Yellow `LimitBanner` shown at top of main area; "Upgrade" link goes to Settings tab |

## Upgrade / Downgrade

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 23 | Pro → Premium mid-month | Pro user upgrades to Premium | `calculateProratedEndDate` credits remaining Pro days; new `endDate` extended accordingly; `aiUsage` counters remain (not reset — month may still apply) |
| 24 | Premium cancelled | User cancels Premium | Subscription `status: 'active'` until `endDate`; `isSubscriptionActive` returns true; access continues; after `endDate`, `getActivePlan` returns `'free'` |
| 25 | SubscriptionPanel — Pro user opens | Pro user opens Settings → SubscriptionPanel | Pro card shows "Current plan" badge; selecting Premium shows "You have Pro. Upgrade to Premium for AI images and chat." hint |
| 26 | SubscriptionPanel — Premium user | Premium user opens SubscriptionPanel | Premium card highlighted; "You're on the top plan!" success hint |
| 27 | Old user (no subscription doc) | User who registered before subscription system | `subscription` state is `null`; `getActivePlan(null) = 'free'`; Free limits apply to all new creates; existing documents are not affected |

## Edge Cases

| # | Scenario | Steps | Expected result |
|---|----------|-------|-----------------|
| 28 | Double-click save (race) | User double-clicks Save in DayTaskEditor | `incrementFreeUsageAtomic` runs twice concurrently; Firestore Transaction serializes them; only one succeeds if at the limit |
| 29 | Network error on save | `setDoc` fails after atomic increment | `decrementFreeUsageAtomic` called in catch block; counter restored; user can retry |
| 30 | NoteEditor auto-save race | User types rapidly; multiple debounce fires | `limitPassedRef.current = true` set after first successful increment; subsequent fires skip the check |
| 31 | Month rollover mid-session | User keeps app open across UTC midnight of month end | `subscribeFreeUsage` callback fires; `transactionCount` resets to 0 (window mismatch); UI updates in real-time |
| 32 | AI key not configured | `OPENAI_API_KEY` and `OPENROUTER_API_KEY` both absent | `aiConfig()` throws; `/api/ai/*` returns 500; frontend shows generic error toast |
