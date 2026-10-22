'use strict';

// postbuild: lets the browser fetch the app's own chunks while it is still
// busy with the HTML, the Telegram SDK and main.js.
//
// src/index.tsx loads the app with import('./App'): the request for those
// chunks used to start only once main.js had downloaded AND run (and main.js
// runs only after the blocking Telegram SDK script), one full step after
// everything else. A <link rel="preload"> per chunk in build/index.html
// starts the same downloads at once; nothing runs earlier or in a different
// order — the chunks still execute when main.js asks for them.
//
// The chunks are found in the build itself: the chunk group main.js loads
// for the module whose code contains APP_MARKER (src/App.tsx). If they
// cannot be found the build fails, rather than silently losing the hint.

const fs = require('fs');
const path = require('path');

const APP_MARKER = 'app-chunk-loaded'; // perfMark('app-chunk-loaded') in src/App.tsx

/** Chunk-id groups main.js loads with Promise.all([r.e(a), r.e(b)]) or r.e(a). */
function findChunkGroups(mainSource) {
  const groups = [];
  for (const m of mainSource.matchAll(/Promise\.all\(\[((?:\w+\.e\(\d+\),?)+)\]\)\.then\(\w+\.bind\(/g)) {
    groups.push([...m[1].matchAll(/\.e\((\d+)\)/g)].map(x => x[1]));
  }
  for (const m of mainSource.matchAll(/(?<![\w.\]])\w+\.e\((\d+)\)\.then\(\w+\.bind\(/g)) {
    groups.push([m[1]]);
  }
  return groups;
}

/**
 * The chunk files to preload for the app: the group that contains the chunk
 * holding APP_MARKER. `chunks` maps a chunk id to { js, css?, source }.
 */
function appChunkFiles(mainSource, chunks) {
  const appIds = Object.keys(chunks).filter(id => chunks[id].source.includes(APP_MARKER));
  if (appIds.length !== 1) throw new Error(`expected one chunk with the app marker, found ${appIds.length}`);
  const group = findChunkGroups(mainSource).find(g => g.includes(appIds[0]));
  if (!group) throw new Error('main.js does not load the app chunk in a recognisable way');
  const missing = group.filter(id => !chunks[id]);
  if (missing.length) throw new Error(`chunks without files: ${missing.join(', ')}`);
  return {
    js: group.map(id => chunks[id].js),
    css: group.map(id => chunks[id].css).filter(Boolean),
  };
}

/** index.html with the preload links inserted before </head> (idempotent). */
function withPreloads(html, files, publicPath = '/') {
  const marker = '<!-- enma:app-chunk-preload -->';
  if (html.includes(marker)) return html;
  const links = [
    ...files.css.map(f => `<link rel="preload" as="style" href="${publicPath}${f}">`),
    ...files.js.map(f => `<link rel="preload" as="script" href="${publicPath}${f}">`),
  ].join('');
  if (!html.includes('</head>')) throw new Error('index.html has no </head>');
  return html.replace('</head>', `${marker}${links}</head>`);
}

function readChunks(buildDir) {
  const jsDir = path.join(buildDir, 'static', 'js');
  const cssDir = path.join(buildDir, 'static', 'css');
  const cssFiles = fs.existsSync(cssDir) ? fs.readdirSync(cssDir) : [];
  const chunks = {};
  for (const f of fs.readdirSync(jsDir)) {
    const m = /^(\d+)\.[0-9a-f]+\.chunk\.js$/.exec(f);
    if (!m) continue;
    const css = cssFiles.find(c => new RegExp(`^${m[1]}\\.[0-9a-f]+\\.chunk\\.css$`).test(c));
    chunks[m[1]] = {
      js: `static/js/${f}`,
      css: css ? `static/css/${css}` : undefined,
      source: fs.readFileSync(path.join(jsDir, f), 'utf8'),
    };
  }
  const main = fs.readdirSync(jsDir).find(f => /^main\.[0-9a-f]+\.js$/.test(f));
  if (!main) throw new Error('no main.js in the build');
  return { mainSource: fs.readFileSync(path.join(jsDir, main), 'utf8'), chunks };
}

function run(buildDir) {
  const { mainSource, chunks } = readChunks(buildDir);
  const files = appChunkFiles(mainSource, chunks);
  const indexPath = path.join(buildDir, 'index.html');
  fs.writeFileSync(indexPath, withPreloads(fs.readFileSync(indexPath, 'utf8'), files));
  return files;
}

if (require.main === module) {
  try {
    const files = run(path.join(__dirname, '..', 'build'));
    console.log(`[preloadAppChunks] preloading ${[...files.css, ...files.js].join(', ')}`);
  } catch (err) {
    console.error(`[preloadAppChunks] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { APP_MARKER, findChunkGroups, appChunkFiles, withPreloads, run };
