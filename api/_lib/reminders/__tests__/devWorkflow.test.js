'use strict';

// Static policy checks on the DEV reminder workflow: it must stay DEV-only,
// manual-only (until the schedule is deliberately enabled), minimal in
// privileges and quiet about secrets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..', '..');
const dir = path.join(root, '.github', 'workflows');
const wf = fs.readFileSync(path.join(dir, 'telegram-cron-dev.yml'), 'utf8');
const active = wf.split('\n').filter(l => !l.trim().startsWith('#')).join('\n'); // ignore comments

test('manual trigger only: workflow_dispatch present, no active schedule or push trigger', () => {
  assert.match(active, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(active, /^\s*schedule:/m);
  assert.doesNotMatch(active, /\bcron:\s*["']/);
  assert.doesNotMatch(active, /^\s*(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m);
});

test('the prepared schedule exists only as a comment and is not more frequent than every 5 minutes', () => {
  const commented = wf.split('\n').filter(l => /^\s*#\s*-\s*cron:/.test(l));
  assert.equal(commented.length, 1);
  assert.match(commented[0], /"\*\/5 \* \* \* \*"/);
});

test('least privilege, serialized, bounded: empty GITHUB_TOKEN permissions, concurrency without cancel, timeout, DEV environment', () => {
  assert.match(active, /^permissions:\s*\{\}\s*$/m);
  assert.match(active, /concurrency:\s*\n\s+group:\s*telegram-cron-dev\s*\n\s+cancel-in-progress:\s*false/);
  assert.match(active, /timeout-minutes:\s*[1-5]\b/);
  assert.match(active, /environment:\s*DEV\b/);
});

test('only the two DEV secrets are read; nothing else (no Telegram, Firebase, payment, production or token secrets)', () => {
  const secretsUsed = [...active.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]).sort();
  assert.deepEqual(secretsUsed, ['CRON_ENDPOINT_DEV', 'CRON_SECRET_DEV']);
  assert.doesNotMatch(active, /github\.token|GITHUB_TOKEN/);
});

test('pinned to the DEV endpoint; no production URL, id or bot anywhere in the file (comments included)', () => {
  assert.match(active, /EXPECTED="https:\/\/enma-l4lh\.vercel\.app\/api\/telegram\/cron"/);
  for (const forbidden of ['enma.su', 'enma-4ea29', 'YourArc_bot', 'prj_sfP2tRu4', 'TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'PLATEGA']) {
    assert.ok(!wf.includes(forbidden), `must not mention ${forbidden}`);
  }
  assert.ok(!/telegram-cron\.yml/.test(wf), 'does not reuse the old shared cron workflow');
});

test('it refuses to run against any endpoint other than the pinned one', () => {
  assert.match(active, /if \[ "\$\{CRON_ENDPOINT:-\}" != "\$\{EXPECTED\}" \]; then[\s\S]*?exit 1/);
});

test('the secret is only ever used as a Bearer header and never printed or traced', () => {
  assert.doesNotMatch(active, /set -[a-z]*x/);
  assert.doesNotMatch(active, /--verbose|\bcurl\b[^\n]*\s-v\b|--trace|--dump-header|--include|\s-i\s/);
  const echoes = active.split('\n').filter(l => /^\s*echo\b/.test(l));
  // Messages may name the variables, but must never expand their values.
  for (const line of echoes) assert.ok(!/\$\{?CRON_(SECRET|ENDPOINT)|Authorization/.test(line), line);
  assert.match(active, /--header "Authorization: Bearer \$\{CRON_SECRET\}"/);
});

test('401/403/429/5xx and non-JSON answers fail the job; only 2xx with ok:true succeeds', () => {
  assert.match(active, /case "\$\{code\}" in\s*\n\s+2\?\?\) ;;\s*\n\s+\*\) [^\n]*exit 1 ;;\s*\n\s+esac/);
  assert.match(active, /jq -e '\.ok == true' response\.json/);
  assert.doesNotMatch(active, /\|\|\s*true/);
  assert.doesNotMatch(active, /continue-on-error:\s*true/);
  assert.match(active, /--max-time\s+\d+/);
});

test('only whitelisted result fields are printed (never the raw response)', () => {
  assert.doesNotMatch(active, /cat response\.json|echo "\$\(cat/);
  assert.match(active, /jq -c '\{ok, reminders:/);
});

test('no workflow in the repository calls production; the old shared cron workflow was not repurposed for DEV', () => {
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (file === 'telegram-cron-dev.yml') continue;
    assert.ok(!text.includes('enma.su'), `${file} must not reference the production site`);
    assert.ok(!text.includes('CRON_ENDPOINT_DEV') && !text.includes('CRON_SECRET_DEV'), `${file} must not use the DEV secrets`);
  }
});
