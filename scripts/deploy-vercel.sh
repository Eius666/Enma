#!/usr/bin/env bash
set -euo pipefail

PROD=false
SKIP_WEBHOOK=false
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=true ;;
    --skip-webhook) SKIP_WEBHOOK=true ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
ok()   { echo "  [ok] $*"; }
fail() { echo "  [!!] $*" >&2; exit 1; }
step() { echo; echo "── $* ──────────────────────────────────────────────────"; }

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
step "Checking prerequisites"

node_version=$(node -e "process.exit(parseInt(process.versions.node) < 20 ? 1 : 0)" 2>&1) \
  || fail "Node.js 20+ required. Current: $(node -v)"
ok "Node $(node -v)"

if ! command -v vercel &>/dev/null; then
  fail "Vercel CLI not found. Install: npm i -g vercel"
fi
ok "Vercel CLI $(vercel --version 2>/dev/null | head -1)"

# ── 2. Required env vars ──────────────────────────────────────────────────────
step "Checking required environment variables"

REQUIRED_VARS=(
  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  CRON_SECRET
  FIREBASE_SERVICE_ACCOUNT
  REACT_APP_FIREBASE_API_KEY
  REACT_APP_FIREBASE_PROJECT_ID
  REACT_APP_FIREBASE_AUTH_DOMAIN
  REACT_APP_FIREBASE_APP_ID
  REACT_APP_FIREBASE_MESSAGING_SENDER_ID
  REACT_APP_FIREBASE_STORAGE_BUCKET
)

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  else
    ok "$var is set"
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo
  fail "Missing required env vars: ${MISSING[*]}"
fi

# ── 3. Type check ─────────────────────────────────────────────────────────────
step "Running TypeScript type check"
npx tsc --noEmit && ok "No type errors"

# ── 4. Deploy ────────────────────────────────────────────────────────────────
step "Deploying to Vercel"
if [[ "$PROD" == "true" ]]; then
  vercel --prod
else
  echo "  Preview deploy (pass --prod for production)"
  vercel
fi

# ── 5. Set Telegram webhook ──────────────────────────────────────────────────
if [[ "$SKIP_WEBHOOK" == "false" && -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  step "Registering Telegram webhook"
  node scripts/set-webhook.js && ok "Webhook registered"
else
  echo
  echo "  Skipping webhook setup (use --skip-webhook to suppress this warning)"
  echo "  Run manually: node scripts/set-webhook.js"
fi

echo
echo "Done."
