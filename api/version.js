'use strict';

// Read once at cold start — api/_generated/buildId.json is written fresh by
// scripts/generateBuildId.js on every build (gitignored, never committed).
// The frontend compares this against its own baked-in REACT_APP_BUILD_ID to
// detect a stale, cached bundle (see src/buildFreshness.ts).
let buildInfo;
try {
  buildInfo = require('./_generated/buildId.json');
} catch {
  buildInfo = { buildId: 'unknown' };
}

module.exports = (req, res) => {
  // This endpoint's entire purpose is to never be served stale — a cached
  // "old" response here would defeat the whole mechanism.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, buildId: buildInfo.buildId });
};
