'use strict';

const { VERSIONS } = require('./VERSIONS');

// ── ANSI color codes ──────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
};
const noColor = !process.stdout.isTTY;
const c = (code, text) => noColor ? text : `${code}${text}${C.reset}`;

// ── Progress printer (called per scenario during run) ─────────────────────────

function printProgress(result) {
  const icon = result.pass ? c(C.green, '✓') : c(C.red, '✗');
  const id   = result.critical ? c(C.bold, result.id) : result.id;
  const dur  = `${result.duration}ms`;
  if (result.pass) {
    process.stdout.write(`  ${icon} ${id} ${c(C.gray, dur)}\n`);
  } else {
    process.stdout.write(`  ${icon} ${c(C.red, result.id)} ${c(C.gray, dur)}\n`);
    const msg = result.error?.message ?? String(result.error ?? '');
    process.stdout.write(`      ${c(C.red, msg)}\n`);
    if (result.error?.actual !== undefined || result.error?.expected !== undefined) {
      process.stdout.write(`      expected: ${c(C.green, JSON.stringify(result.error?.expected))}\n`);
      process.stdout.write(`      actual:   ${c(C.red,   JSON.stringify(result.error?.actual))}\n`);
    }
  }
}

// ── Domain-level summary table ────────────────────────────────────────────────

function buildDomainTable(results) {
  const domains = {};
  for (const r of results) {
    if (!domains[r.domain]) domains[r.domain] = { total: 0, critical: 0, passed: 0, failed: [] };
    const d = domains[r.domain];
    d.total++;
    if (r.critical) d.critical++;
    if (r.pass) d.passed++;
    else d.failed.push(r.id);
  }
  return domains;
}

// ── Full report (printed at end of run) ───────────────────────────────────────

function printReport(results, durationMs) {
  const total    = results.length;
  const passed   = results.filter(r => r.pass).length;
  const failed   = results.filter(r => !r.pass).length;
  const critical = results.filter(r => r.critical && !r.pass).length;

  console.log();
  console.log(c(C.bold + C.white, '══════════════════════════════════════════════'));
  console.log(c(C.bold + C.white, ' ENMA AI Evaluation & Regression Suite Report'));
  console.log(c(C.bold + C.white, '══════════════════════════════════════════════'));

  // Version metadata
  console.log(c(C.gray, `  core=${VERSIONS.core}  contextRouter=${VERSIONS.contextRouter}  skillRouter=${VERSIONS.skillRouter}  convState=${VERSIONS.conversationState}`));
  console.log();

  // Summary line
  const statusIcon = failed === 0 ? c(C.green, '● PASS') : c(C.red, '● FAIL');
  console.log(`  ${statusIcon}  ${c(C.bold, String(total))} scenarios  `
    + `${c(C.green, String(passed))} passed  `
    + (failed > 0 ? c(C.red, `${failed} failed`) : c(C.gray, '0 failed'))
    + `  ${c(C.gray, `${durationMs}ms`)}`);

  if (critical > 0) {
    console.log(`  ${c(C.red, `⚠  ${critical} CRITICAL failure(s) — pipeline integrity at risk`)}`);
  }
  console.log();

  // Domain table
  const domainData = buildDomainTable(results);
  const COL_W = [16, 9, 8, 7, 20];
  const row = (...cols) => cols.map((col, i) => String(col).padEnd(COL_W[i])).join('  ');

  console.log(c(C.bold, row('Domain', 'Scenarios', 'Critical', 'Passed', 'Failed IDs')));
  console.log(c(C.gray, '─'.repeat(COL_W.reduce((s, w) => s + w + 2, 0))));

  for (const [domain, d] of Object.entries(domainData)) {
    const allPass = d.passed === d.total;
    const failStr = d.failed.length ? d.failed.join(', ').slice(0, 35) : '-';
    const passStr = allPass
      ? c(C.green, String(d.passed))
      : c(C.red, String(d.passed));
    console.log(row(domain, d.total, d.critical, passStr, failStr));
  }
  console.log();

  // Golden conversations summary
  const goldenIds = results.filter(r => r.id.startsWith('conversation.'));
  if (goldenIds.length) {
    console.log(c(C.bold, '  Golden Conversations'));
    for (const r of goldenIds) {
      const icon = r.pass ? c(C.green, '✓') : c(C.red, '✗');
      console.log(`    ${icon} ${r.id}`);
    }
    console.log();
  }

  // Security summary
  const secResults = results.filter(r => r.domain === 'security');
  if (secResults.length) {
    console.log(c(C.bold, '  Security'));
    for (const r of secResults) {
      const icon = r.pass ? c(C.green, '✓') : c(C.red, '✗');
      console.log(`    ${icon} ${r.id}${r.pass ? '' : c(C.red, ` — ${r.error?.message?.slice(0, 80)}`)}`);
    }
    console.log();
  }

  // Failures detail
  const failures = results.filter(r => !r.pass);
  if (failures.length) {
    console.log(c(C.bold + C.red, '  Failures'));
    for (const r of failures) {
      console.log();
      console.log(`    ${c(C.red, '✗')} ${c(C.bold, r.id)}${r.critical ? c(C.red, ' [CRITICAL]') : ''}`);
      console.log(`      ${r.description}`);
      const msg = r.error?.message ?? String(r.error ?? '');
      console.log(`      Error:    ${c(C.red, msg)}`);
      if (r.error?.expected !== undefined)
        console.log(`      Expected: ${c(C.green, JSON.stringify(r.error.expected))}`);
      if (r.error?.actual !== undefined)
        console.log(`      Actual:   ${c(C.red, JSON.stringify(r.error.actual))}`);
      if (r.snapshot && Object.keys(r.snapshot).length)
        console.log(`      Snapshot: ${c(C.gray, JSON.stringify(r.snapshot))}`);
    }
    console.log();
  }

  // Performance baselines (warnings only)
  const slowThresholdMs = 2000;
  const slow = results.filter(r => r.duration > slowThresholdMs);
  if (slow.length) {
    console.log(c(C.yellow, '  ⚡ Performance warnings (> ' + slowThresholdMs + 'ms)'));
    for (const r of slow) {
      console.log(`     ${r.id}: ${r.duration}ms`);
    }
    console.log();
  }

  console.log(c(C.gray, '══════════════════════════════════════════════'));
}

// ── JSON report (for CI / artifact storage) ──────────────────────────────────

function buildJsonReport(results, durationMs) {
  return {
    versions:    VERSIONS,
    runAt:       new Date().toISOString(),
    durationMs,
    summary: {
      total:    results.length,
      passed:   results.filter(r => r.pass).length,
      failed:   results.filter(r => !r.pass).length,
      critical: results.filter(r => r.critical && !r.pass).length,
    },
    domains: buildDomainTable(results),
    results: results.map(r => ({
      id:          r.id,
      domain:      r.domain,
      critical:    r.critical,
      pass:        r.pass,
      duration:    r.duration,
      description: r.description,
      snapshot:    r.snapshot,
      error:       r.error ? {
        type:     r.error.assertionType,
        message:  r.error.message,
        expected: r.error.expected,
        actual:   r.error.actual,
      } : null,
    })),
  };
}

module.exports = { printProgress, printReport, buildJsonReport };
