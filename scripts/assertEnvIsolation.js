'use strict';

// Build-time guard (wired into `prebuild`). No-op unless ENMA_ENV=dev; then
// refuses to build a client bundle that points at production resources.
//
// CRA bakes REACT_APP_* values from .env files into the bundle AFTER prebuild
// runs, so a DEV build on a machine that has production values in .env.local
// would otherwise pass this check with the shell env alone. We therefore merge
// the same files CRA would load (shell env wins, as in CRA) and check the result.
const fs = require('fs');
const path = require('path');
const { assertClientConfig } = require('../api/_lib/envIsolation');

// CRA precedence for `build`: first match wins.
const CRA_FILES = ['.env.production.local', '.env.local', '.env.production', '.env'];

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function mergeCraEnv(dir, shellEnv) {
  const merged = {};
  for (const f of [...CRA_FILES].reverse()) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) Object.assign(merged, parseEnvFile(fs.readFileSync(p, 'utf8')));
  }
  return { ...merged, ...shellEnv };
}

if (require.main === module) {
  try {
    assertClientConfig(mergeCraEnv(path.join(__dirname, '..'), process.env));
  } catch (err) {
    console.error(`✖ ${err.message} — refusing to build a DEV bundle against production.`);
    process.exit(1);
  }
}

module.exports = { mergeCraEnv, parseEnvFile };
