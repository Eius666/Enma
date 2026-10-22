'use strict';

// Architecture checks for the client (src/) and the server (api/), run with
// the unit tests. They read the import graph statically (scripts/lib/
// importGraph.js); nothing is executed.
//
// Client layers, inner to outer — an import may only point inwards:
//   domain          types, pure rules and helpers (no React, no Firebase, no browser state)
//   infrastructure  Firebase, Telegram, network, storage, configuration
//   application     React hooks that combine the two for the screens
//   presentation    components, the app shell, the admin panel
//
// Lists marked "ratchet" record today's accepted exceptions: they may shrink
// (then update the list), never grow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, buildGraph, findCycles } = require('../lib/importGraph');

const src = buildGraph('src', ['.ts', '.tsx']);
const api = buildGraph('api', ['.js']);

const DOMAIN_LIB = ['dayTask', 'noteDrafts', 'noteSyncStatus', 'authBootstrap', 'appDefaults', 'snapshotReducers', 'userLabels'];

function layerOf(file) {
  if (/^src\/(App|index)\.tsx$/.test(file)) return 'presentation';
  if (/^src\/components\//.test(file)) return 'presentation';
  if (/^src\/admin\/(pages|components)\//.test(file) || /^src\/admin\/(App|Layout|Login)\.tsx$/.test(file)) return 'presentation';
  if (/^src\/(hooks|admin\/hooks)\//.test(file)) return 'application';
  if (/^src\/(types|utils|i18n|constants)\//.test(file) || file === 'src/subscription.ts') return 'domain';
  if (DOMAIN_LIB.some(n => file === `src/lib/${n}.ts`)) return 'domain';
  return 'infrastructure';
}
const RANK = { domain: 0, infrastructure: 1, application: 2, presentation: 3 };
const productionSrc = () => [...src.values()].filter(n => !n.test);

test('the graph is not empty (the parser sees imports)', () => {
  assert.ok(src.get('src/App.tsx').edges.length > 20);
  assert.ok(api.get('api/ai/[action].js').edges.length > 20);
});

test('client: no runtime import cycles', () => {
  assert.deepEqual(findCycles(src), []);
});

test('client: imports only point inwards (domain ← infrastructure ← application ← presentation)', () => {
  const violations = [];
  for (const n of productionSrc()) {
    const from = layerOf(n.file);
    for (const e of n.edges) {
      const to = layerOf(e.to);
      if (RANK[to] > RANK[from]) violations.push(`${from} → ${to}: ${n.file} imports ${e.to}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('client: the domain layer uses no React, Firebase or wallet SDK', () => {
  const violations = [];
  for (const n of productionSrc()) {
    if (layerOf(n.file) !== 'domain') continue;
    for (const p of n.packages) if (/^(react|react-dom|firebase|@tonconnect)(\/|$)/.test(p)) violations.push(`${n.file} → ${p}`);
  }
  assert.deepEqual(violations, []);
});

// Ratchet: screens that still talk to Firestore directly. New screens go
// through a hook (application layer) instead.
const PRESENTATION_FIRESTORE = [
  'src/App.tsx',
  'src/components/CalendarView.tsx',
  'src/components/DayList.tsx',
  'src/components/DayTaskEditor.tsx',
  'src/components/FinanceEditor.tsx',
  'src/components/FinanceList.tsx',
  'src/components/GoalsList.tsx',
  'src/components/HabitEditor.tsx',
  'src/components/HabitsList.tsx',
  'src/components/NoteEditor.tsx',
  'src/components/NotesList.tsx',
  'src/components/SubscriptionPanel.tsx',
];

test('client (ratchet): no new screen talks to Firestore directly', () => {
  const actual = productionSrc()
    .filter(n => layerOf(n.file) === 'presentation' && n.packages.includes('firebase/firestore'))
    .map(n => n.file).sort();
  const added = actual.filter(f => !PRESENTATION_FIRESTORE.includes(f));
  const removed = PRESENTATION_FIRESTORE.filter(f => !actual.includes(f));
  assert.deepEqual(added, [], 'move these Firestore calls into a hook (src/hooks) instead');
  assert.deepEqual(removed, [], 'these no longer import Firestore — remove them from PRESENTATION_FIRESTORE');
});

test('client (ratchet): the app shell stays small', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8').split('\n').length;
  assert.ok(lines <= 450, `src/App.tsx has ${lines} lines; move tab or feature logic into src/components/tabs or a hook`);
});

// ── server ──────────────────────────────────────────────────────────────────

const isRouteEntry = (f) => /^api\//.test(f) && !f.split('/').some(s => s.startsWith('_')) && !/__tests__/.test(f);

test('server: no import cycles (including lazy requires)', () => {
  assert.deepEqual(findCycles(api), []);
});

test('server: shared modules never load a route entry (only routers load handlers)', () => {
  const violations = [];
  for (const n of api.values()) {
    if (n.test || isRouteEntry(n.file)) continue;
    for (const e of n.edges) if (isRouteEntry(e.to)) violations.push(`${n.file} → ${e.to}`);
  }
  assert.deepEqual(violations, []);
});

// Handler factories receive db/admin from the router that builds them (see
// api/ai/[action].js and api/_lib/tools.js); loading Firebase themselves would
// bind them to whatever instance was loaded first.
const isHandlerFactory = (f) => /^api\/_lib\/(admin|botTools)\//.test(f) || /^api\/_lib\/.+Handlers\.js$/.test(f) || f === 'api/_lib/auth/requestGuards.js';

test('server: handler factories never load Firebase themselves', () => {
  const violations = [];
  for (const n of api.values()) {
    if (n.test || !isHandlerFactory(n.file)) continue;
    for (const e of n.edges) if (e.to === 'api/_lib/firebaseAdmin.js') violations.push(n.file);
  }
  assert.ok([...api.keys()].filter(isHandlerFactory).length >= 15, 'handler factories are found');
  assert.deepEqual(violations, []);
});

test('server: route files stay thin', () => {
  for (const [file, max] of [['api/ai/[action].js', 200], ['api/cron/[job].js', 100], ['api/insights/[action].js', 100]]) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
    assert.ok(lines <= max, `${file}: ${lines} lines (limit ${max})`);
  }
});
