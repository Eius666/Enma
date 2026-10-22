'use strict';

// POST /api/ai/<action> — one Vercel Function for the Web app's server
// actions, the partner program and the admin panel (the Hobby plan allows at
// most 12 Functions per deployment). This file only wires dependencies and
// routes; the handlers live with their domains in api/_lib:
//
//   entities/entityHandlers.js     entityCreate
//   finance/financeHandlers.js     transactionUpdate, exportFinancePdf, goalCreate|Adjust|Delete
//   referral/partnerHandlers.js    partnerLogin, partnerMe, partnerLink, partnerBotInfo
//   referral/referralHandlers.js   referralValidate, referralInfo
//   admin/otpHandlers.js           adminVerifyOtp, adminSetupOtp
//   admin/statsHandlers.js         adminStats, adminAiUsage
//   admin/usersHandlers.js         adminUsers
//   admin/billingHandlers.js       adminSubscriptions, adminPayments, adminPromoCodes
//   admin/referralAdminHandlers.js adminReferrals, referralPayout
//   admin/messagesHandler.js       adminMessages
//   admin/starsDiagnostics.js      adminStarsDiagnostics, adminStarsCanaryCheck
//   admin/habitSmokeTest.js        adminHabitSmokeTestCreate|Status|Delete
//   admin/notesDiagnostic.js       adminNotesDiagnostic
//
// Handler modules get every stateful dependency (Firebase, services) from here
// and never load Firebase themselves, so one load of this file — in
// production or in a test that substitutes modules — wires them all.

const { db, admin } = require('../_lib/firebaseAdmin');
const { HOME_BUDGET_CURRENCY } = require('../_lib/config');
const { createEntityInFirestore, getActivePlan, ENTITY_COLLECTION_MAP } = require('../_lib/entities/createEntity');
const { createFinancialTransaction, buildTransactionUpdate, TransactionValidationError } = require('../_lib/transactions/financialTransaction');
const { FxUnavailableError } = require('../_lib/fx');
const { checkAndIncrementAiUsage, AI_LIMITS } = require('../_lib/aiUsage');
const { exportFinancePdf } = require('../_lib/pdf/exportFinancePdf');
const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const { resolveReminderSchedule } = require('../_lib/reminders/schedule');
const {
  verifyTelegramLoginWidget, issuePartnerSession, verifyPartnerSession, bearerToken,
} = require('../_lib/referral/partnerAuth');
const {
  findOrCreatePartnerByTelegram, getPartnerSummary, getOrCreateTrackingLink, normalizePlatform, botUsername,
} = require('../_lib/referral/partners');

const { createRequireAuth, requireAdmin } = require('../_lib/auth/requestGuards');
const { createEntityHandlers } = require('../_lib/entities/entityHandlers');
const { createFinanceHandlers } = require('../_lib/finance/financeHandlers');
const { createPartnerHandlers } = require('../_lib/referral/partnerHandlers');
const { createReferralHandlers } = require('../_lib/referral/referralHandlers');
const { createOtpHandlers } = require('../_lib/admin/otpHandlers');
const { createStatsHandlers } = require('../_lib/admin/statsHandlers');
const { createUsersHandlers } = require('../_lib/admin/usersHandlers');
const { createBillingHandlers } = require('../_lib/admin/billingHandlers');
const { createReferralAdminHandlers } = require('../_lib/admin/referralAdminHandlers');
const { createMessagesHandler } = require('../_lib/admin/messagesHandler');
const { createStarsDiagnostics } = require('../_lib/admin/starsDiagnostics');
const { createHabitSmokeTestHandlers } = require('../_lib/admin/habitSmokeTest');
const { createNotesDiagnostic } = require('../_lib/admin/notesDiagnostic');

const ctx = {
  db, admin,
  requireAuth: createRequireAuth(admin),
  requireAdmin,
  HOME_BUDGET_CURRENCY,
  createEntityInFirestore, getActivePlan, ENTITY_COLLECTION_MAP,
  createFinancialTransaction, buildTransactionUpdate, TransactionValidationError,
  FxUnavailableError,
  checkAndIncrementAiUsage, AI_LIMITS,
  exportFinancePdf,
  rateLimit, getClientIp,
  resolveReminderSchedule,
  verifyTelegramLoginWidget, issuePartnerSession, verifyPartnerSession, bearerToken,
  findOrCreatePartnerByTelegram, getPartnerSummary, getOrCreateTrackingLink, normalizePlatform, botUsername,
};

const entities    = createEntityHandlers(ctx);
const finance     = createFinanceHandlers(ctx);
const partners    = createPartnerHandlers(ctx);
const referral    = createReferralHandlers(ctx);
const otp         = createOtpHandlers(ctx);
const stats       = createStatsHandlers(ctx);
const users       = createUsersHandlers(ctx);
const billing     = createBillingHandlers(ctx);
const referrers   = createReferralAdminHandlers(ctx);
const messages    = createMessagesHandler(ctx);
const stars       = createStarsDiagnostics(ctx);
const smokeTest   = createHabitSmokeTestHandlers(ctx);
const notesDiag   = createNotesDiagnostic(ctx);

// A Map, not an object: only these exact strings route (no prototype keys, and
// a repeated ?action= parameter — an array — never matches).
const HANDLERS = new Map(Object.entries({
  entityCreate:              entities.handleEntityCreate,
  transactionUpdate:         finance.handleTransactionUpdate,
  exportFinancePdf:          finance.handleExportFinancePdf,
  goalCreate:                finance.handleGoalCreate,
  goalAdjust:                finance.handleGoalAdjust,
  goalDelete:                finance.handleGoalDelete,
  partnerLogin:              partners.handlePartnerLogin,
  partnerMe:                 partners.handlePartnerMe,
  partnerLink:               partners.handlePartnerLink,
  partnerBotInfo:            partners.handlePartnerBotInfo,
  referralValidate:          referral.handleReferralValidate,
  referralInfo:              referral.handleReferralInfo,
  referralPayout:            referrers.handleReferralPayout,
  adminVerifyOtp:            otp.handleAdminVerifyOtp,
  adminSetupOtp:             otp.handleAdminSetupOtp,
  adminStats:                stats.handleAdminStats,
  adminUsers:                users.handleAdminUsers,
  adminSubscriptions:        billing.handleAdminSubscriptions,
  adminPayments:             billing.handleAdminPayments,
  adminReferrals:            referrers.handleAdminReferrals,
  adminPromoCodes:           billing.handleAdminPromoCodes,
  adminMessages:             messages.handleAdminMessages,
  adminAiUsage:              stats.handleAdminAiUsage,
  adminStarsDiagnostics:     stars.handleAdminStarsDiagnostics,
  adminStarsCanaryCheck:     stars.handleAdminStarsCanaryCheck,
  adminHabitSmokeTestCreate: smokeTest.handleAdminHabitSmokeTestCreate,
  adminHabitSmokeTestStatus: smokeTest.handleAdminHabitSmokeTestStatus,
  adminHabitSmokeTestDelete: smokeTest.handleAdminHabitSmokeTestDelete,
  adminNotesDiagnostic:      notesDiag.handleAdminNotesDiagnostic,
}));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.query;

  try {
    const handler = HANDLERS.get(action);
    if (!handler) {
      return res.status(404).json({ error: `Unknown AI action: ${action}` });
    }
    return await handler(req, res);
  } catch (err) {
    console.error(`[ai/${action}] unhandled error:`, err.message, err.stack);
    if (err.statusCode === 503) {
      return res.status(503).json({ error: 'AI перегружен, повторите через минуту' });
    }
    const isAdmin = String(action).startsWith('admin');
    return res.status(500).json({ error: isAdmin ? err.message : 'Internal server error' });
  }
};
