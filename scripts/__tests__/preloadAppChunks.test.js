'use strict';

// scripts/preloadAppChunks.js (postbuild): finds the chunks main.js loads for
// src/App.tsx and declares them in index.html, without touching anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findChunkGroups, appChunkFiles, withPreloads, run, APP_MARKER } = require('../preloadAppChunks');

// Shapes copied from a real CRA 5 production main.js.
const MAIN = 'x(){return"/admin"===p?t.e(441).then(t.bind(t,441)):Promise.all([t.e(964),t.e(798)]).then(t.bind(t,7798))}';

test('the chunk groups main.js loads are read from its loader calls', () => {
  assert.deepEqual(findChunkGroups(MAIN), [['964', '798'], ['441']]);
});

test('the app group is the one holding the App module, with its CSS', () => {
  const chunks = {
    964: { js: 'static/js/964.a.chunk.js', source: 'vendor' },
    798: { js: 'static/js/798.b.chunk.js', css: 'static/css/798.c.chunk.css', source: `x("${APP_MARKER}")` },
    441: { js: 'static/js/441.d.chunk.js', source: 'admin' },
  };
  assert.deepEqual(appChunkFiles(MAIN, chunks), {
    js: ['static/js/964.a.chunk.js', 'static/js/798.b.chunk.js'],
    css: ['static/css/798.c.chunk.css'],
  });
});

test('a build it cannot read fails loudly instead of silently dropping the hint', () => {
  assert.throws(() => appChunkFiles(MAIN, { 964: { js: 'a', source: '' } }), /one chunk with the app marker/);
  assert.throws(() => appChunkFiles('nothing', { 1: { js: 'a', source: APP_MARKER } }), /recognisable/);
});

test('links go before </head>, scripts and everything else unchanged; running twice adds nothing', () => {
  const html = '<head><script src="https://telegram.org/js/telegram-web-app.js"></script><script defer="defer" src="/static/js/main.1.js"></script></head><body></body>';
  const once = withPreloads(html, { js: ['static/js/964.a.chunk.js'], css: ['static/css/798.c.chunk.css'] });
  assert.equal(once, '<head><script src="https://telegram.org/js/telegram-web-app.js"></script><script defer="defer" src="/static/js/main.1.js"></script>'
    + '<!-- enma:app-chunk-preload --><link rel="preload" as="style" href="/static/css/798.c.chunk.css"><link rel="preload" as="script" href="/static/js/964.a.chunk.js"></head><body></body>');
  assert.equal(withPreloads(once, { js: ['x'], css: [] }), once);
});

test('end to end on a build directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enma-preload-'));
  fs.mkdirSync(path.join(dir, 'static', 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'static', 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'static', 'js', 'main.0abc.js'), MAIN);
  fs.writeFileSync(path.join(dir, 'static', 'js', '964.11aa.chunk.js'), 'vendor');
  fs.writeFileSync(path.join(dir, 'static', 'js', '798.22bb.chunk.js'), `"${APP_MARKER}"`);
  fs.writeFileSync(path.join(dir, 'static', 'js', '441.33cc.chunk.js'), 'admin');
  fs.writeFileSync(path.join(dir, 'static', 'css', '798.44dd.chunk.css'), '');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body></body></html>');
  run(dir);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="preload" as="script" href="\/static\/js\/964\.11aa\.chunk\.js">/);
  assert.match(html, /<link rel="preload" as="script" href="\/static\/js\/798\.22bb\.chunk\.js">/);
  assert.match(html, /<link rel="preload" as="style" href="\/static\/css\/798\.44dd\.chunk\.css">/);
  assert.doesNotMatch(html, /441/);
});

test('src/App.tsx still carries the marker the script looks for', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'App.tsx'), 'utf8');
  assert.match(app, new RegExp(`perfMark\\('${APP_MARKER}'\\)`));
});
