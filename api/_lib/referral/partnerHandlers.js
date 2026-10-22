'use strict';

// Partner (affiliate) program actions of POST /api/ai/<action> — folded into
// that route, not its own function, to stay under Vercel's Hobby-plan
// serverless function cap. Auth here is a separate HMAC session token (see
// partnerAuth.js), NOT the Firebase ID token requireAuth expects — a partner
// may have no Enma account at all.
//
// Built by the api/ai router with its dependencies injected (see
// api/ai/[action].js).

const BOT_USERNAME_CACHE_MS = 5 * 60 * 1000;

function createPartnerHandlers(ctx) {
  const {
    rateLimit, getClientIp,
    verifyTelegramLoginWidget, issuePartnerSession, verifyPartnerSession, bearerToken,
    findOrCreatePartnerByTelegram, getPartnerSummary, getOrCreateTrackingLink, normalizePlatform, botUsername,
  } = ctx;

  async function requirePartner(req, res) {
    const token = bearerToken(req);
    const result = verifyPartnerSession(token);
    if (!result.ok) {
      res.status(401).json({ error: 'unauthorized', code: result.reason });
      return null;
    }
    return result.code;
  }

  async function handlePartnerLogin(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const ip = getClientIp(req);
    if (!(await rateLimit(`partner_login:${ip}`, 10, 60 * 1000))) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const verified = verifyTelegramLoginWidget(req.body || {}, process.env.TELEGRAM_BOT_TOKEN);
    if (!verified.ok) {
      return res.status(401).json({ error: 'invalid_telegram_signature', code: verified.reason });
    }

    try {
      const partner = await findOrCreatePartnerByTelegram(verified.user);
      const token = issuePartnerSession(partner.code);
      return res.status(200).json({
        ok: true, token,
        partner: { code: partner.code, name: partner.name, status: partner.status || 'active' },
      });
    } catch (err) {
      console.error('[ai/partnerLogin] error:', err.message);
      return res.status(500).json({ error: 'Failed to sign in' });
    }
  }

  async function handlePartnerMe(req, res) {
    // Every action on this route is POST-only (enforced by the router) — no
    // separate GET method here, unlike the dashboard summary's original
    // standalone-route design.
    const code = await requirePartner(req, res);
    if (!code) return;
    try {
      const summary = await getPartnerSummary(code);
      if (!summary) return res.status(404).json({ error: 'partner_not_found' });
      return res.status(200).json({ ok: true, partner: summary });
    } catch (err) {
      console.error('[ai/partnerMe] error:', err.message);
      return res.status(500).json({ error: 'Failed to load dashboard' });
    }
  }

  async function handlePartnerLink(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const code = await requirePartner(req, res);
    if (!code) return;
    const platform = normalizePlatform((req.body || {}).platform);
    try {
      const link = await getOrCreateTrackingLink(code, platform);
      return res.status(200).json({ ok: true, ...link });
    } catch (err) {
      console.error('[ai/partnerLink] error:', err.message);
      return res.status(500).json({ error: 'Failed to create link' });
    }
  }

  // Not a secret — a bot's @username is public by design (anyone the bot has
  // ever messaged, or anyone who opens its Menu Button, can see it). This
  // exists purely so partners.html never has to hardcode it or trust a
  // possibly-stale config value: it asks Telegram itself (getMe) which
  // @username the live TELEGRAM_BOT_TOKEN actually resolves to right now —
  // the same token every other bot feature (webhook, Stars, sendMessage)
  // already runs on — so it can never drift out of sync with reality again.
  // Cached in-memory for a few minutes per warm instance; falls back to the
  // config-based botUsername() (process.env.TELEGRAM_BOT_USERNAME or its
  // hardcoded default) only if Telegram's API is briefly unreachable.
  let cachedBotUsername = null;
  let cachedBotUsernameAt = 0;

  async function resolveLiveBotUsername() {
    if (cachedBotUsername && Date.now() - cachedBotUsernameAt < BOT_USERNAME_CACHE_MS) {
      return cachedBotUsername;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return botUsername();
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await resp.json();
      if (data?.ok && data.result?.username) {
        cachedBotUsername = data.result.username;
        cachedBotUsernameAt = Date.now();
        return cachedBotUsername;
      }
    } catch (err) {
      console.error('[ai/partnerBotInfo] getMe failed:', err.message);
    }
    return botUsername();
  }

  async function handlePartnerBotInfo(req, res) {
    const liveUsername = await resolveLiveBotUsername();
    // configBotUsername is what the consumer referral links (codes.js,
    // commands.js — not touched by this endpoint) currently resolve to:
    // process.env.TELEGRAM_BOT_USERNAME if set, else the same hardcoded
    // fallback. Neither value is secret (a bot's @username is public) — this
    // is a safe runtime read, not a raw env dump, and it's the only way to
    // tell whether TELEGRAM_BOT_USERNAME is actually correct in production
    // without being able to read a Sensitive-masked env var directly.
    const configUsername = botUsername();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({
      ok: true,
      botUsername: liveUsername,
      configBotUsername: configUsername,
      configMatchesLive: configUsername === liveUsername,
    });
  }

  return { handlePartnerLogin, handlePartnerMe, handlePartnerLink, handlePartnerBotInfo };
}

module.exports = { createPartnerHandlers };
