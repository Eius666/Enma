'use strict';

// Single Vercel Function for every /api/cron/<job> endpoint.
//
// Why: the Hobby plan allows at most 12 Serverless Functions per deployment and
// the four cron handlers used to take four of them. The public URLs are
// unchanged:
//   /api/cron/content-plan | /api/cron/content-publish
//   /api/cron/maintenance  | /api/cron/insights
//
// The handlers themselves live in api/_cron/<job>.js (a leading underscore keeps
// them from being deployed as Functions) and are untouched: each still does its
// own method check, CRON_SECRET authentication, and error handling. This router
// only picks one — it performs NO authentication of its own and never skips the
// handler's.
//
// Safety:
//  - the job comes from the request PATH, not from the query string, so
//    `/api/cron/maintenance?job=insights` still runs `maintenance`;
//  - only the four names below are accepted (exact match, case-sensitive); each
//    is a literal require(), there is no dynamic import from user input;
//  - anything else answers 404.
const { getEnvName } = require('../_lib/envIsolation');

const HANDLERS = {
  'content-plan':    () => require('../_cron/content-plan'),
  'content-publish': () => require('../_cron/content-publish'),
  'maintenance':     () => require('../_cron/maintenance'),
  'insights':        () => require('../_cron/insights'),
};

function pathSegment(req) {
  let pathname = '';
  try { pathname = new URL(req.url || '', 'http://localhost').pathname; } catch (_) { return null; }
  const m = /^\/api\/cron\/([^/]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

// Which job was asked for.
//  1. The URL path is authoritative: `/api/cron/maintenance?job=insights` runs
//     `maintenance`.
//  2. Some runtimes hand the function the REWRITTEN url
//     (`/api/cron/[job]?job=maintenance`, the dynamic-route destination that
//     Vercel generates). Only in that exact case do we read `req.query.job`,
//     which Vercel itself filled from the path. Either way the value must pass
//     the allowlist, and the handler's own auth still runs afterwards.
function jobFromRequest(req) {
  const seg = pathSegment(req);
  if (seg !== null && Object.prototype.hasOwnProperty.call(HANDLERS, seg)) return seg;
  if (seg === '[job]' && req.query && typeof req.query.job === 'string') return req.query.job;
  return null;
}

function devWithoutCronSecret() {
  let env;
  try { env = getEnvName(); } catch (_) { return true; } // unrecognised ENMA_ENV: fail closed
  return env === 'dev' && !String(process.env.CRON_SECRET || '').trim();
}

module.exports = async (req, res) => {
  const job = jobFromRequest(req);
  if (!job || !Object.prototype.hasOwnProperty.call(HANDLERS, job)) {
    res.status(404).json({ ok: false, error: 'unknown_cron_job' });
    return;
  }
  // DEV fail-closed: several cron handlers treat an unset CRON_SECRET as "no
  // authentication", so in DEV the router refuses to run any job until a secret
  // exists. Production (ENMA_ENV unset) is untouched. A wrong/missing credential
  // with a configured secret is still answered 401 by the handler itself.
  if (devWithoutCronSecret()) {
    res.status(503).json({ ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' });
    return;
  }
  return HANDLERS[job]()(req, res);
};

module.exports.JOBS = Object.keys(HANDLERS);
