'use strict';

// Golden-master check for POST /api/ai/<action>: every scenario in
// characterization/scenarios.js must produce exactly the recorded status,
// headers, body, Firestore writes, outgoing HTTP calls and log lines.
//
// The golden file was recorded from the router before it was split into
// domain modules; the split must not change a single recorded byte.
// Regenerate ONLY for a deliberate behaviour change:
//   UPDATE_GOLDEN=1 node --test api/ai/__tests__/actionRouter.characterization.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario } = require('../../__tests__/support/characterization');
const { scenarios } = require('./characterization/scenarios');

const GOLDEN = path.join(__dirname, 'characterization', 'actionRouter.golden.json');
const TARGET = { kind: 'http', entry: path.join(__dirname, '..', '[action].js') };
const update = process.env.UPDATE_GOLDEN === '1';

test('scenario names are unique', () => {
  const names = scenarios.map(s => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('every routed action is exercised', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'api', '__tests__', 'apiSurface.contract.test.js'), 'utf8');
  const block = /const AI_ACTIONS = \{([\s\S]*?)\n\};/.exec(src)[1];
  const actions = [...block.matchAll(/\[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map(x => x[1]));
  assert.equal(actions.length, 29);
  const covered = new Set();
  for (const s of scenarios) for (const st of (s.steps || [s.request])) if (typeof st === 'object' && st.action) covered.add(st.action);
  for (const a of actions) assert.ok(covered.has(a), `no scenario for ${a}`);
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
