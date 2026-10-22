'use strict';

// User referral actions of POST /api/ai/<action>: validating a referral or
// partner code before checkout, and the user's own referral info. Built by
// the api/ai router with its dependencies injected (see api/ai/[action].js).

function createReferralHandlers(ctx) {
  const { db, requireAuth, botUsername } = ctx;

  // Validate an influencer (partner) code or a user referral code.
  async function handleReferralValidate(req, res) {
    const verifiedUid = await requireAuth(req, res);
    if (!verifiedUid) return;

    const { code } = req.body ?? {};
    if (!code) return res.status(400).json({ valid: false, error: 'missing_code' });

    // Try influencer code first
    const { validateInfluencerCode } = require('./influencer');
    const influencerResult = await validateInfluencerCode(code, verifiedUid);
    if (influencerResult.valid) {
      return res.status(200).json(influencerResult);
    }

    // Try user referral code (8-char code from users.referralCode)
    const { findUserByReferralCode } = require('./codes');
    const referrer = await findUserByReferralCode(code);
    if (!referrer) {
      return res.status(200).json({ valid: false, error: 'code_not_found' });
    }

    // Self-referral check (uses verified uid — cannot be spoofed)
    if (referrer.id === verifiedUid) {
      return res.status(200).json({ valid: false, error: 'self_referral' });
    }

    // Check if user already has a referrer
    const userSnap = await db.collection('users').doc(verifiedUid).get();
    if (userSnap.exists && userSnap.data().referredBy) {
      return res.status(200).json({ valid: false, error: 'already_referred' });
    }

    return res.status(200).json({ valid: true, discountPercent: 0, type: 'user' });
  }

  // Fetch referral info for a user (ensures referralCode exists).
  async function handleReferralInfo(req, res) {
    const verifiedUid = await requireAuth(req, res);
    if (!verifiedUid) return;
    const userId = verifiedUid;

    const { ensureReferralCode } = require('./codes');
    const code = await ensureReferralCode(userId);

    const userSnap = await db.collection('users').doc(userId).get();
    const userData = userSnap.exists ? userSnap.data() : {};

    const referralLink  = code ? `https://t.me/${botUsername()}?start=ref_${code}` : (userData.referralLink || null);

    // Count referrals this user has made
    const referralsSnap = await db.collection('referrals').where('referrerId', '==', userId).get();

    return res.status(200).json({
      ok:                     true,
      referralCode:           code || userData.referralCode || null,
      referralLink,
      referralBalance:        userData.referralBalance        || 0,
      totalReferralEarnedRub: userData.totalReferralEarnedRub || 0,
      referredBy:             userData.referredBy             || null,
      totalReferred:          referralsSnap.size,
    });
  }

  return { handleReferralValidate, handleReferralInfo };
}

module.exports = { createReferralHandlers };
