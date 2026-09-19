#!/usr/bin/env node
'use strict';

const path   = require('path');
const fs     = require('fs');
const { printProgress, printReport, buildJsonReport } = require('./report');

// ── Global firebaseAdmin mock ─────────────────────────────────────────────────
// Injected before every scenario run so modules that import firebaseAdmin at
// load time (tools, insights) always get the mock, not real Firebase.

function setupGlobalMocks() {
  const {
    createMockDb, mockAdmin, mockGetUserTimezone, mockGetUserCurrency,
  } = require('./fixtures');
  const fa  = require.resolve('../firebaseAdmin');
  const cur = require.cache[fa];
  // Only inject if not already a live scenario-specific mock
  if (!cur || cur._isGlobalFallback) {
    const globalDb = createMockDb({});
    require.cache[fa] = {
      id: fa, filename: fa, loaded: true, _isGlobalFallback: true,
      exports: {
        db:              globalDb,
        admin:           mockAdmin,
        getUserTimezone: mockGetUserTimezone,
        getUserCurrency: mockGetUserCurrency,
      },
    };
  }
}

// ── Load all scenario files ───────────────────────────────────────────────────

const SCENARIO_FILES = [
  './scenarios/currency',
  './scenarios/proactive',
];

function loadScenarios() {
  const all = [];
  for (const f of SCENARIO_FILES) {
    const scenarios = require(f);
    for (const s of scenarios) {
      if (!s.id || !s.domain || typeof s.run !== 'function') {
        console.warn(`[runner] Skipping malformed scenario in ${f}:`, JSON.stringify(s).slice(0, 80));
        continue;
      }
      all.push(s);
    }
  }
  return all;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key  = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else                                 args[key] = true;
    }
  }
  return args;
}

function filterScenarios(scenarios, args) {
  let list = scenarios;
  if (args.domain)         list = list.filter(s => s.domain === args.domain);
  if (args.scenario)       list = list.filter(s => s.id === args.scenario);
  if (args['critical-only']) list = list.filter(s => s.critical);
  return list;
}

// ── Single scenario runner ────────────────────────────────────────────────────

async function runOne(scenario) {
  // Re-inject global mock before every scenario — some teardowns delete it
  setupGlobalMocks();
  const start = Date.now();
  let   result;
  try {
    await scenario.run();
    result = {
      id:          scenario.id,
      domain:      scenario.domain,
      description: scenario.description,
      critical:    !!scenario.critical,
      pass:        true,
      duration:    Date.now() - start,
      snapshot:    scenario.snapshot ?? {},
      error:       null,
    };
  } catch (err) {
    result = {
      id:          scenario.id,
      domain:      scenario.domain,
      description: scenario.description,
      critical:    !!scenario.critical,
      pass:        false,
      duration:    Date.now() - start,
      snapshot:    scenario.snapshot ?? {},
      error:       err,
    };
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args     = parseArgs(process.argv.slice(2));
  const jsonOut  = args['json-output'];

  // ── Header
  console.log('\n  ENMA AI Evaluation & Regression Suite');
  if (args.domain)           console.log(`  Filter: domain=${args.domain}`);
  if (args.scenario)         console.log(`  Filter: scenario=${args.scenario}`);
  if (args['critical-only']) console.log('  Filter: critical only');
  console.log();

  // ── Inject global mock before anything loads modules that require firebaseAdmin
  setupGlobalMocks();

  // ── Load + filter
  let scenarios;
  try {
    scenarios = filterScenarios(loadScenarios(), args);
  } catch (e) {
    console.error('Failed to load scenarios:', e.message);
    process.exit(2);
  }

  if (scenarios.length === 0) {
    console.log('  No scenarios matched. Check --domain / --scenario flags.');
    process.exit(0);
  }

  // Print domain breakdown
  const byDomain = {};
  for (const s of scenarios) {
    byDomain[s.domain] = (byDomain[s.domain] || 0) + 1;
  }
  console.log('  Scenarios to run:', scenarios.length);
  for (const [d, n] of Object.entries(byDomain)) {
    console.log(`    ${d}: ${n}`);
  }
  console.log();

  // ── Run
  const start   = Date.now();
  const results = [];

  for (const scenario of scenarios) {
    const result = await runOne(scenario);
    results.push(result);
    printProgress(result);
  }

  const duration = Date.now() - start;

  // ── Report
  printReport(results, duration);

  // ── Optional JSON output
  if (jsonOut) {
    const report = buildJsonReport(results, duration);
    const outPath = typeof jsonOut === 'string' ? jsonOut : 'eval-report.json';
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n  JSON report: ${outPath}`);
  }

  // ── Exit code: 1 if any critical scenario failed
  const criticalFailed = results.some(r => !r.pass && r.critical);
  if (criticalFailed) {
    console.error('\n  \x1b[31m⛔  Critical regression detected — exit code 1\x1b[0m\n');
    process.exit(1);
  }

  // Also exit 1 if any failure (not just critical) when --fail-fast
  if (args['fail-all'] && results.some(r => !r.pass)) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n[runner] Unexpected error:', e);
  process.exit(2);
});
