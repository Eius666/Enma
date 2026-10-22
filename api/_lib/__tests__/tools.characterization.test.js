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
