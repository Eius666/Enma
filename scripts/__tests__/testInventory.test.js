'use strict';

// Every test file belongs to a test level, and every level is run by a
// package.json script:
//   unit        node --test, no network, no emulator          npm run test:unit
//   component   jest + jsdom (React components, the app shell)  npm run test:ui
//   emulator    Firestore emulator, demo project only           npm run test:rules, test:*-integration, test:migration
//   evals       AI regression scenarios (runner, not test files) npm run test:brain
// Nothing here runs a test; it only reads package.json and the file list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts;

// Only the app's own code is listed; separate projects in the repository
// (finance-bot, my-organizer) have their own tooling.
const testFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'api', 'src', 'scripts', 'functions/src', 'firestore-tests'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
  .toString().split('\n').filter(Boolean)
  .filter(f => fs.existsSync(path.join(ROOT, f)))
  .filter(f => /(\.test\.(c?js|mjs|ts|tsx)$)/.test(f));

const words = (s) => String(s || '').split(/[\s"]+/).filter(Boolean);
const unitFiles = words(scripts['test:unit']).filter(w => /\.test\./.test(w));
const emulatorScripts = Object.entries(scripts).filter(([, cmd]) => /firebase emulators:exec/.test(cmd));
const emulatorFiles = emulatorScripts.flatMap(([, cmd]) => words(cmd).filter(w => /\.test\./.test(w)));
const JEST_PATTERN = /(src\/components\/__tests__\/|\.jest\.test\.)/;

// TypeScript sources of Firebase Functions tests run as their compiled copy.
const compiledCopy = (f) => f.replace(/^functions\/src\//, 'functions/lib/').replace(/\.ts$/, '.js');

function levelOf(file) {
  if (unitFiles.includes(file) || unitFiles.includes(compiledCopy(file))) return 'unit';
  if (emulatorFiles.includes(file) || emulatorFiles.includes(compiledCopy(file))) return 'emulator';
  if (JEST_PATTERN.test(file)) return 'component';
  return null;
}

test('the jest pattern used by test:ui is the one this check assumes', () => {
  assert.match(scripts['test:ui'], /src\/components\/__tests__\/\|\\\.jest\\\.test\\\./);
});

test('every test file is run by exactly one level', () => {
  assert.ok(testFiles.length > 50, 'test files are found');
  const orphans = testFiles.filter(f => levelOf(f) === null);
  assert.deepEqual(orphans, [], 'add these to a test script (or delete them)');
  const both = testFiles.filter(f => (unitFiles.includes(f) || unitFiles.includes(compiledCopy(f))) && (emulatorFiles.includes(f) || emulatorFiles.includes(compiledCopy(f))));
  assert.deepEqual(both, []);
});

test('every file listed in test:unit exists and is listed once', () => {
  const missing = unitFiles.filter(f => !fs.existsSync(path.join(ROOT, f)) && !/^functions\/lib\//.test(f));
  assert.deepEqual(missing, []);
  assert.equal(new Set(unitFiles).size, unitFiles.length, 'duplicates in test:unit');
});

test('unit tests never need the emulator, component tests never run under node --test', () => {
  for (const f of unitFiles) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/@firebase\/rules-unit-testing|FIRESTORE_EMULATOR_HOST\s*=/.test(src), `${f} needs the emulator`);
    assert.ok(!JEST_PATTERN.test(f), `${f} is a jest test`);
  }
});

test('emulator suites only ever run against the local demo project', () => {
  assert.ok(emulatorScripts.length >= 5);
  for (const [name, cmd] of emulatorScripts) {
    assert.match(cmd, /--only firestore --project enma-rules-test /, name);
    assert.doesNotMatch(cmd, /enma-4ea29|enmadev-aa7b1/, name);
  }
});

test('CI runs the unit, component and emulator levels', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run test:unit/);
  assert.match(ci, /test:ui|react-scripts test/);
  assert.match(ci, /test:rules|emulators:exec/);
});
