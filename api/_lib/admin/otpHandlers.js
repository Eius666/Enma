'use strict';

// Admin second factor (TOTP) — POST /api/ai/adminVerifyOtp and adminSetupOtp.
// The admin API key is checked first; the TOTP secret lives in
// ADMIN_TOTP_SECRET. Built by the api/ai router (see api/ai/[action].js).

const { verifyTotp, generateTotpSecret } = require('../auth/totp');

function createOtpHandlers(ctx) {
  const { requireAdmin } = ctx;

  async function handleAdminVerifyOtp(req, res) {
    // API key must be valid to even attempt OTP verification
    if (!requireAdmin(req, res)) return;

    const secret = process.env.ADMIN_TOTP_SECRET;

    if (!secret) {
      // 2FA not configured — return ok so login can proceed without TOTP
      return res.status(200).json({ ok: true, required: false });
    }

    const { token } = req.body ?? {};
    if (!token) {
      return res.status(200).json({ ok: false, required: true, error: 'token_required' });
    }

    const valid = verifyTotp(secret, String(token));
    return res.status(200).json({ ok: valid, required: true, error: valid ? null : 'invalid_token' });
  }

  async function handleAdminSetupOtp(req, res) {
    if (!requireAdmin(req, res)) return;

    const existingSecret = process.env.ADMIN_TOTP_SECRET;
    // Use existing secret (to show on another device) or generate a new candidate
    const secret = existingSecret || generateTotpSecret();
    const uri    = `otpauth://totp/Enma%20Admin?secret=${secret}&issuer=Enma&algorithm=SHA1&digits=6&period=30`;

    // If admin sends a test token, verify it against the secret in the request body
    const { testToken, candidateSecret } = req.body ?? {};
    if (testToken) {
      const s     = candidateSecret || existingSecret || '';
      const valid = s ? verifyTotp(s, String(testToken)) : false;
      return res.status(200).json({ ok: valid, error: valid ? null : 'invalid_token' });
    }

    return res.status(200).json({
      ok:                 true,
      secret,
      uri,
      alreadyConfigured:  !!existingSecret,
    });
  }

  return { handleAdminVerifyOtp, handleAdminSetupOtp };
}

module.exports = { createOtpHandlers };
