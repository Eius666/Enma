// node --test src/lib/__tests__/perfMarks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPerfMarksEnabled, formatPerfSummary, perfMark, getPerfEntries } from '../perfMarks.ts';

test('enabled only in a development build or with the explicit build flag', () => {
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production', REACT_APP_PERF_MARKS: 'true' }), true);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'production', REACT_APP_PERF_MARKS: '1' }), false);
  assert.equal(isPerfMarksEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(isPerfMarksEnabled({}), false);
});

test('disabled builds record nothing', () => {
  // This process is neither a development build nor flagged.
  perfMark('app-chunk-loaded');
  perfMark('shell-rendered');
  assert.deepEqual(getPerfEntries(), []);
});

test('the summary holds phase names and milliseconds only', () => {
  assert.equal(
    formatPerfSummary([{ phase: 'app-chunk-loaded', ms: 180 }, { phase: 'auth-resolved', ms: 420 }]),
    'app-chunk-loaded 180ms → auth-resolved 420ms',
  );
});
