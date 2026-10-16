# Git → Vercel auto-deploy: owner checklist (BLOCKS ANY `git push`)

Evidence (GitHub public Deployments/Statuses API, read-only): project `enma` created 241 `Production` deployments from pushes to `main` (2025-11-26 … 2026-10-05) via `vercel[bot]`; project `enma-l4lh` reports a failing status on `b69ed3e`. Nothing below has been verified inside Vercel — the Vercel API/dashboard was unreachable from the executor (Security Checkpoint). **Status of every box is "unknown" until the owner ticks it.**

| Project | ID | Purpose | Git connected? | Production Branch | Auto-deploy of `main` | Action | Owner confirmed (date) |
|---|---|---|---|---|---|---|---|
| `enma` | prj_sfP2tRu4Q7iM1v0RVu9oFFE5gdeX | PRODUCTION (`enma.su`) | **owner states: disconnected** (Stage 08) — not independently verifiable by the executor | n/a | historically YES (241 deployments, last 2026-10-05) | request Dashboard screenshot (Settings → Git) | ☐ |
| `enma-l4lh` (**DEV**, per owner, Stage 08; earlier called `enma-dev`) | prj_wwGqJR959AHCKURTDE20rRXrsb2c | DEV | YES — wanted | must be `main` | YES — wanted (single DEV deployer; CI has no deploy job) | keep; confirm variables complete BEFORE the push | ☐ |

## Per project (Dashboard → project → Settings → Git)
1. Note *Connected Git Repository* and *Production Branch*.
2. Disable auto-deploy, either:
   - **Disconnect** (cleanest; existing deployments and domains keep working, CLI deploys unaffected), or
   - *Ignored Build Step* → "Don't build anything" (command `exit 0`), keeping the link.
3. Check *Deploy Hooks* (Settings → Git): list them, delete none without a decision.
4. Check Deployment Protection / Production Branch rules.
5. Proof (must be recorded before any push): the Deployments tab shows no new deployment after the next harmless trigger — **but do not trigger it with a push to `main`.** Acceptable proof: screenshot/notes of the settings above, or the owner's explicit statement. Alternatively push a throw-away commit to a *fork or a temporary repository*, never to `Eius666/Enma`.
6. Also verify in GitHub: repository → Settings → Integrations/GitHub Apps → *Vercel* → which repositories/projects it can access.

## Independent verification the executor CAN do (read-only)
- GitHub Deployments API for `Eius666/Enma` (public): after the owner disconnects, a later push would show no new `vercel[bot]` deployment — not usable as a pre-push test.
- `scripts/vercel-dev.js` / the Vercel CLI cannot read Git settings reliably and is currently blocked.

## Rules until both rows are confirmed
- No `git push` of any kind (the 26 local commits would publish `e720ef7` to `enma.su`).
- `enma-l4lh` is the DEV project (owner, Stage 08). The earlier unknown-project concern is resolved by the owner's statement; the project ID matches the DEV ID given by the owner.
- Production secret `TELEGRAM_WEBHOOK_SECRET` must exist in `enma` **before** SEC-12 code ever reaches production.
