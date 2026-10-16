'use strict';

// Firebase CLI wrapper for DEV. Always passes an explicit --project taken from
// DEV_FIREBASE_PROJECT_ID and refuses the production project id.
//   DEV_FIREBASE_PROJECT_ID=<dev-id> node scripts/firebase-dev.js deploy --only firestore:rules
const { spawnSync } = require('child_process');
const { PROD_FIREBASE_PROJECT_ID } = require('../api/_lib/envIsolation');

function buildArgs(args, env = process.env) {
  const id = env.DEV_FIREBASE_PROJECT_ID;
  if (!id) throw new Error('DEV_FIREBASE_PROJECT_ID is required');
  if (id === PROD_FIREBASE_PROJECT_ID) throw new Error('DEV_FIREBASE_PROJECT_ID must not be the production project');
  // `deploy` must name its targets and may only touch Firestore here
  // (rules/indexes). Functions and hosting are not part of the first DEV launch.
  if (args[0] === 'deploy') {
    const i = args.indexOf('--only');
    const only = i >= 0 ? String(args[i + 1] || '') : '';
    if (!only || !only.split(',').every((t) => t.startsWith('firestore'))) {
      throw new Error('deploy requires --only firestore:rules,firestore:indexes (functions/hosting are not enabled for DEV)');
    }
  }
  if (args.some((a) => a === '--project' || a === '-P' || a.startsWith('--project='))) {
    throw new Error('Do not pass --project; it is set from DEV_FIREBASE_PROJECT_ID');
  }
  return [...args, '--project', id];
}

if (require.main === module) {
  // `--print-only` (our flag, not Firebase's) shows the exact command and exits.
  const raw = process.argv.slice(2);
  const printOnly = raw.includes('--print-only');
  let full;
  try { full = buildArgs(raw.filter((a) => a !== '--print-only')); } catch (e) { console.error(`✖ ${e.message}`); process.exit(1); }
  if (printOnly) { console.log(`firebase ${full.join(' ')}`); process.exit(0); }
  process.exit(spawnSync('firebase', full, { stdio: 'inherit' }).status ?? 1);
}

module.exports = { buildArgs };
