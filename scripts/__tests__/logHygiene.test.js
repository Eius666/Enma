'use strict';

// Server logs must not carry secrets or user content (message texts, task or
// reminder titles, prompts, initData, tokens). This reads every console.* call
// in api/ and flags arguments that mention such values (string literals are
// fine — only the values passed in are checked).
//
// Ratchet: KNOWN lists today's accepted cases; it may shrink, never grow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, trackedFiles, isTest } = require('../lib/importGraph');

const acorn = require(require.resolve('acorn', { paths: [ROOT] }));
const walk = require(require.resolve('acorn-walk', { paths: [ROOT] }));

const SENSITIVE = /^(token|botToken|tgToken|secret|cronSecret|initData|password|authHeader|authorization|apiKey|adminKey|idToken|customToken|text|messageText|telegramText|body|payload|email|phone|args|prompt|fullPrompt|title|description|content|query|chatId|userText|caption)$/i;

// file → snippets of the accepted calls (start of the call's source text)
const KNOWN = {
  'api/_lib/tools.js': ["console.log('[create_reminder] raw args:'", "console.log('[create_task] raw args:'"],
  'api/_lib/botTools/imageTools.js': ["console.log('[generate_image] model:'"],
  'api/_lib/botTools/financeTools.js': ["console.error('[export_finance_pdf] Telegram rejected the document:'"],
  'api/payment/[action].js': ["console.error('[payment/starsCreate] Telegram error:'"],
  'api/telegram/cron.js': ["console.error('[cron] automation', docRef.id, 'send failed:'"],
  'api/telegram/webhook.js': ["console.error('[WH][vision] API error:'", "console.log('[WH][voice] transcribed'", "console.error('[WH][stars] successful_payment for unknown chatId:'"],
};

function findings() {
  const out = [];
  for (const file of trackedFiles('api', ['.js'])) {
    if (isTest(file) || /\/evals\//.test(file)) continue;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
    walk.simple(ast, {
      CallExpression(node) {
        const c = node.callee;
        if (!(c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'console')) return;
        let hit = false;
        for (const arg of node.arguments) {
          walk.full(arg, (x) => {
            if (x.type === 'Identifier' && SENSITIVE.test(x.name)) hit = true;
            if (x.type === 'MemberExpression' && !x.computed && x.property && SENSITIVE.test(x.property.name)) hit = true;
          });
        }
        if (hit) out.push({ file, call: src.slice(node.start, node.end).replace(/\s+/g, ' ') });
      },
    });
  }
  return out;
}

test('no new log line carries secrets or user content', () => {
  const unknown = findings().filter(f => !(KNOWN[f.file] || []).some(s => f.call.startsWith(s)));
  assert.deepEqual(unknown.map(f => `${f.file}: ${f.call.slice(0, 140)}`), [],
    'log ids, counts, codes or lengths instead of the value itself');
});

test('the accepted list is still accurate (remove entries that were fixed)', () => {
  const found = findings();
  const stale = [];
  for (const [file, snippets] of Object.entries(KNOWN)) {
    for (const s of snippets) if (!found.some(f => f.file === file && f.call.startsWith(s))) stale.push(`${file}: ${s}`);
  }
  assert.deepEqual(stale, []);
});

test('the scan recognises a sensitive value (self-check)', () => {
  const ast = acorn.parse("console.log('[x] sent', telegramText, req.headers.authorization)", { ecmaVersion: 'latest' });
  let hits = 0;
  walk.simple(ast, { CallExpression(n) { for (const a of n.arguments) walk.full(a, x => { if ((x.type === 'Identifier' && SENSITIVE.test(x.name)) || (x.type === 'MemberExpression' && !x.computed && SENSITIVE.test(x.property.name))) hits++; }); } });
  assert.ok(hits >= 2);
});
