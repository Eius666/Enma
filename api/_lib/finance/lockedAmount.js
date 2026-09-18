'use strict';

// schemaVersion-2 transactions carry a ruble value locked at creation time.
// Budget math reads it directly — no runtime FX, no currency resolution.
// Anything without it is legacy and goes through the legacy resolver path.
function hasLockedRub(tx) {
  return !!tx && tx.schemaVersion === 2 && Number.isFinite(tx.rubAmount);
}

module.exports = { hasLockedRub };
