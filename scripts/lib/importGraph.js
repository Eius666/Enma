'use strict';

// Static import graph of the client (src/, TypeScript) and the server (api/,
// CommonJS) — used by the architecture checks in scripts/__tests__. Parses
// import/require statements with regular expressions (no compiler needed);
// only relative specifiers become edges, packages are reported separately.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function trackedFiles(prefix, exts) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', prefix], { cwd: ROOT })
    .toString().split('\n').filter(Boolean)
    .filter(f => exts.some(e => f.endsWith(e)))
    .filter(f => fs.existsSync(path.join(ROOT, f)));
}

const isTest = (f) => /(^|\/)__tests__\/|\.test\.|\.spec\.|setupTests\./.test(f);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// { spec, typeOnly, lazy }
function parseImports(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    out.push({ spec: m[2], typeOnly: !!m[1], lazy: false });
  }
  for (const m of code.matchAll(/^\s*export\s+(type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ spec: m[2], typeOnly: !!m[1], lazy: false });
  }
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: m[1], typeOnly: false, lazy: true });
  }
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const before = code.slice(Math.max(0, m.index - 200), m.index);
    // A require() inside a function body is lazy; top-level ones start a line.
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const indented = /^\s+/.test(code.slice(lineStart, m.index)) && !/^(const|let|var)\b/.test(code.slice(lineStart, m.index).trim());
    out.push({ spec: m[1], typeOnly: false, lazy: indented || /=>\s*$/.test(before.trim()) });
  }
  return out;
}

function resolveRelative(fromFile, spec, exts) {
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  const candidates = [base, ...exts.map(e => base + e), ...exts.map(e => path.join(base, 'index' + e))];
  for (const c of candidates) {
    if (fs.existsSync(path.join(ROOT, c)) && fs.statSync(path.join(ROOT, c)).isFile()) return c;
  }
  return null;
}

function buildGraph(prefix, exts) {
  const files = trackedFiles(prefix, exts);
  const nodes = new Map();
  for (const f of files) {
    const imports = parseImports(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const edges = [];
    const packages = [];
    for (const imp of imports) {
      if (imp.spec.startsWith('.')) {
        const to = resolveRelative(f, imp.spec, exts);
        if (to) edges.push({ to, typeOnly: imp.typeOnly, lazy: imp.lazy });
      } else {
        packages.push(imp.spec);
      }
    }
    nodes.set(f, { file: f, test: isTest(f), edges, packages });
  }
  return nodes;
}

// Strongly connected components with more than one file (or a self-loop),
// following only runtime edges (type-only imports vanish at build time).
function findCycles(nodes, { includeLazy = true, includeTests = false } = {}) {
  let index = 0;
  const stack = [];
  const info = new Map();
  const cycles = [];
  const succ = (n) => nodes.get(n).edges
    .filter(e => !e.typeOnly && (includeLazy || !e.lazy) && nodes.has(e.to) && (includeTests || !nodes.get(e.to).test))
    .map(e => e.to);
  function strong(v) {
    info.set(v, { index, low: index, on: true });
    index++;
    stack.push(v);
    for (const w of succ(v)) {
      if (!info.has(w)) { strong(w); info.get(v).low = Math.min(info.get(v).low, info.get(w).low); }
      else if (info.get(w).on) info.get(v).low = Math.min(info.get(v).low, info.get(w).index);
    }
    if (info.get(v).low === info.get(v).index) {
      const comp = [];
      let w;
      do { w = stack.pop(); info.get(w).on = false; comp.push(w); } while (w !== v);
      if (comp.length > 1 || succ(v).includes(v)) cycles.push(comp.sort());
    }
  }
  for (const n of nodes.keys()) {
    if (!includeTests && nodes.get(n).test) continue;
    if (!info.has(n)) strong(n);
  }
  return cycles;
}

module.exports = { ROOT, buildGraph, findCycles, parseImports, trackedFiles, isTest };
