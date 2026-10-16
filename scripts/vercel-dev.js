'use strict';

// Vercel CLI wrapper for the DEV project. It makes it impossible to hit the
// production project by accident:
//   - target comes ONLY from DEV_VERCEL_PROJECT_ID + VERCEL_ORG_ID (env), never
//     from a local `.vercel` link;
//   - the production project id is refused;
//   - it refuses to run in a directory that has a `.vercel` link or `.env*`
//     files (use a clean copy);
//   - only an allow-list of subcommands.
//   DEV_VERCEL_PROJECT_ID=prj_... VERCEL_ORG_ID=team_... node scripts/vercel-dev.js env ls
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROD_VERCEL_PROJECT_ID } = require('../api/_lib/envIsolation');

// Read-only subcommands only. DEV is deployed by the Vercel Git Integration
// (push to main); a manual `deploy` would create a duplicate deployment.
const ALLOWED = [['env', 'ls'], ['inspect'], ['ls'], ['project', 'inspect'], ['logs']];

function check(args, env = process.env, cwd = process.cwd()) {
  const id = env.DEV_VERCEL_PROJECT_ID;
  if (!/^prj_[A-Za-z0-9]+$/.test(id || '')) throw new Error('DEV_VERCEL_PROJECT_ID (prj_…) is required');
  if (id === PROD_VERCEL_PROJECT_ID) throw new Error('DEV_VERCEL_PROJECT_ID is the production project — refusing');
  if (!/^team_[A-Za-z0-9]+$/.test(env.VERCEL_ORG_ID || '')) throw new Error('VERCEL_ORG_ID (team_…) is required');
  if (!ALLOWED.some((a) => a.every((w, i) => args[i] === w))) throw new Error(`subcommand not allowed: ${args[0] || '(none)'}`);
  if (args.some((a) => a === '--scope' || a === '--cwd' || a === '--project' || a === '-S')) {
    throw new Error('do not pass --scope/--cwd/--project; the target comes from the environment');
  }
  if (fs.existsSync(path.join(cwd, '.vercel'))) throw new Error('.vercel link present in this directory — use a clean copy');
  const stray = fs.readdirSync(cwd).filter((f) => f.startsWith('.env') && f !== '.env.dev.example' && f !== '.env.example');
  if (stray.length) throw new Error('.env* files present in this directory — use a clean copy');
  return { ...env, VERCEL_PROJECT_ID: id, VERCEL_ORG_ID: env.VERCEL_ORG_ID };
}

if (require.main === module) {
  const raw = process.argv.slice(2);
  const printOnly = raw.includes('--print-only');
  const args = raw.filter((a) => a !== '--print-only');
  let childEnv;
  try { childEnv = check(args); } catch (e) { console.error(`✖ ${e.message}`); process.exit(1); }
  if (printOnly) { console.log(`vercel ${args.join(' ')}  [project=${childEnv.VERCEL_PROJECT_ID}]`); process.exit(0); }
  process.exit(spawnSync('vercel', args, { stdio: 'inherit', env: childEnv }).status ?? 1);
}

module.exports = { check };
