'use strict';

// Covers api/version.js — the stale-bundle detection endpoint
// (src/buildFreshness.ts compares its own baked-in build id against this).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function mockRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  return res;
}

test('GET /api/version: always responds 200 with a buildId and Cache-Control: no-store', async () => {
  delete require.cache[require.resolve('../version')];
  const handler = require('../version');
  const res = mockRes();
  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(typeof res.body.buildId === 'string' && res.body.buildId.length > 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('GET /api/version: never crashes even if api/_generated/buildId.json is missing or malformed — falls back to "unknown"', async () => {
  const generatedDir = path.join(__dirname, '..', '_generated');
  const filePath = path.join(generatedDir, 'buildId.json');
  const existed = fs.existsSync(filePath);
  const backup = existed ? fs.readFileSync(filePath, 'utf8') : null;

  try {
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(filePath, 'not valid json {{{');
    delete require.cache[require.resolve('../version')];
    try { delete require.cache[require.resolve('../_generated/buildId.json')]; } catch (_) {}
    const handler = require('../version');
    const res = mockRes();
    await handler({}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.buildId, 'unknown');
  } finally {
    if (backup !== null) fs.writeFileSync(filePath, backup);
    else fs.rmSync(filePath, { force: true });
    delete require.cache[require.resolve('../version')];
  }
});
