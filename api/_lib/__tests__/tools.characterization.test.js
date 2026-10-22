'use strict';

// Golden-master check for api/_lib/tools.js (the Telegram assistant's tools):
// every scenario in characterization/toolsScenarios.js must produce exactly
// the recorded return values, Firestore writes, outgoing HTTP calls and log
// lines.
//
// The golden file was recorded from tools.js before its domains were moved
// into separate modules; that move must not change a single recorded byte.
// Regenerate ONLY for a deliberate behaviour change:
//   UPDATE_GOLDEN=1 node --test api/_lib/__tests__/tools.characterization.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('../../__tests__/support/characterization');
const { scenarios } = require('./characterization/toolsScenarios');

const GOLDEN = path.join(__dirname, 'characterization', 'tools.golden.json');
const TARGET = { kind: 'call', entry: path.join(__dirname, '..', 'tools.js') };
const update = process.env.UPDATE_GOLDEN === '1';

test('scenario names are unique', () => {
  const names = scenarios.map(s => s.name);
  assert.equal(new Set(names).size, names.length);
});

// A zero-offset zone ('UTC', or no zone in the harness's UTC process) is named
// by ICU: 'GMT' with ICU 77 (Node 22), 'GMT+0' with ICU 78 (Node 24 — Vercel
// and CI). Pinned here as either, not byte-for-byte in the golden file.
test('getUtcOffsetStr: a zero offset is named the way the runtime ICU names it', async () => {
  const out = await runScenario({
    name: 'zero offset',
    steps: [{ call: (m) => m.getUtcOffsetStr('UTC') }, { call: (m) => m.getUtcOffsetStr(undefined) }],
  }, TARGET);
  const [utc, none] = out.steps.map(s => s.returned);
  assert.match(utc, /^GMT(\+0)?$/);
  assert.equal(none, utc);
  assert.deepEqual(out.steps.map(s => [s.writes, s.fetch, s.logs]), [[{}, [], []], [{}, [], []]]);
});

if (update) {
  test('record golden file', async () => {
    const out = {};
    for (const s of scenarios) out[s.name] = await runScenario(s, TARGET);
    fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
  });
} else {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

  test('golden file and scenario list match', () => {
    assert.deepEqual(Object.keys(golden).sort(), scenarios.map(s => s.name).sort());
  });

  for (const s of scenarios) {
    test(s.name, async () => {
      const actual = JSON.parse(JSON.stringify(await runScenario(s, TARGET)));
      assert.deepEqual(actual, golden[s.name]);
    });
  }
}
