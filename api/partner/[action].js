'use strict';

// Partner (affiliate) program API — self-service, NOT Firebase-Auth-based.
//
//   POST /api/partner/telegramLogin  — Telegram Login Widget payload -> session token
//   GET  /api/partner/me             — dashboard summary for the session's partner
//   POST /api/partner/link           — get-or-create a per-platform tracking link
//
// A partner is not necessarily an Enma user (no Firebase account required),
// so auth here is a small HMAC session token keyed off their Telegram
// identity — see _lib/referral/partnerAuth.js. All business logic (codes,
// counters, commission) lives in _lib/referral/partners.js +
// _lib/referral/influencer.js; this file is just the HTTP boundary.

const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const {
  verifyTelegramLoginWidget,
  issuePartnerSession,
  verifyPartnerSession,
  bearerToken,
} = require('../_lib/referral/partnerAuth');
const {
  findOrCreatePartnerByTelegram,
  getPartnerSummary,
  getOrCreateTrackingLink,
  normalizePlatform,
} = require('../_lib/referral/partners');

async function requirePartner(req, res) {
  const token = bearerToken(req);
  const result = verifyPartnerSession(token);
  if (!result.ok) {
    res.status(401).json({ error: 'unauthorized', code: result.reason });
    return null;
  }
  return result.code;
}

async function handleTelegramLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  if (!(await rateLimit(`partner_login:${ip}`, 10, 60 * 1000))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const verified = verifyTelegramLoginWidget(req.body || {}, botToken);
  if (!verified.ok) {
    return res.status(401).json({ error: 'invalid_telegram_signature', code: verified.reason });
  }

  try {
    const partner = await findOrCreatePartnerByTelegram(verified.user);
    const token = issuePartnerSession(partner.code);
    return res.status(200).json({
      ok: true,
      token,
      partner: { code: partner.code, name: partner.name, status: partner.status || 'active' },
    });
  } catch (err) {
    console.error('[partner/telegramLogin] error:', err.message);
    return res.status(500).json({ error: 'Failed to sign in' });
  }
}

async function handleMe(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const code = await requirePartner(req, res);
  if (!code) return;

  try {
    const summary = await getPartnerSummary(code);
    if (!summary) return res.status(404).json({ error: 'partner_not_found' });
    return res.status(200).json({ ok: true, partner: summary });
  } catch (err) {
    console.error('[partner/me] error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard' });
  }
}

async function handleLink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const code = await requirePartner(req, res);
  if (!code) return;

  const platform = normalizePlatform((req.body || {}).platform);
  try {
    const link = await getOrCreateTrackingLink(code, platform);
    return res.status(200).json({ ok: true, ...link });
  } catch (err) {
    console.error('[partner/link] error:', err.message);
    return res.status(500).json({ error: 'Failed to create link' });
  }
}

module.exports = async (req, res) => {
  const { action } = req.query;
  switch (action) {
    case 'telegramLogin': return handleTelegramLogin(req, res);
    case 'me':             return handleMe(req, res);
    case 'link':            return handleLink(req, res);
    default:
      return res.status(404).json({ error: 'Unknown action' });
  }
};
