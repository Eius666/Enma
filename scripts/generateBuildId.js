#!/usr/bin/env node
'use strict';

// Generates one fresh, unique build id per build and makes it available to
// BOTH the frontend bundle (REACT_APP_BUILD_ID, inlined by CRA at build
// time) and the backend (api/_generated/buildId.json, read at runtime by
// api/version.js) from the exact same value — so a possibly-stale,
// already-loaded client can compare itself against the live server and
// detect when it's running an old bundle (see src/buildFreshness.ts).
//
// Runs automatically before every `npm run build` via the npm "pre"
// lifecycle hook (see package.json's "prebuild" script) — including
// Vercel's own remote build step, which also runs `npm run build`.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function shortGitSha() {
  try {
    return execSync('git rev-parse --short=10 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return null; // .git may not be present in the build environment — fine, timestamp alone is still unique
  }
}

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || shortGitSha();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const buildId = sha ? `${timestamp}-${sha}` : timestamp;

// Frontend: CRA only inlines env vars that are present in .env*.local files
// (or the shell) at build time. This file is gitignored and rewritten on
// every build — existing keys other than REACT_APP_BUILD_ID are preserved.
const envPath = path.join(__dirname, '..', '.env.production.local');
let existing = '';
try { existing = fs.readFileSync(envPath, 'utf8'); } catch { /* may not exist yet */ }
const keptLines = existing.split('\n').filter((l) => l && !l.startsWith('REACT_APP_BUILD_ID='));
keptLines.push(`REACT_APP_BUILD_ID=${buildId}`);
fs.writeFileSync(envPath, keptLines.join('\n') + '\n');

// Backend: a plain JSON file bundled alongside the serverless functions —
// Vercel's Node builder traces static `require()` calls, so api/version.js
// reading this file needs no extra configuration.
const generatedDir = path.join(__dirname, '..', 'api', '_generated');
fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(path.join(generatedDir, 'buildId.json'), JSON.stringify({ buildId }) + '\n');

console.log(`[generateBuildId] ${buildId}`);
