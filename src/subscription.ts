// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Enma Subscription & Payment Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type PlanType = 'free' | 'pro' | 'premium';
export type PaidPlan = 'pro' | 'premium';
export type SubscriptionPeriod = 'month' | 'year';
export type PaymentCurrency = 'ton' | 'usdt' | 'stars' | 'sbp';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface PlanConfig {
  id: PaidPlan;
  name: { en: string; ru: string };
  monthlyPrice: number;
  yearlyPrice: number;
}

export const PLANS: Record<PaidPlan, PlanConfig> = {
  pro: {
    id: 'pro',
    name: { en: 'Pro', ru: 'Про' },
    monthlyPrice: 8,
    yearlyPrice: 80,
  },
  premium: {
    id: 'premium',
    name: { en: 'Premium', ru: 'Премиум' },
    monthlyPrice: 11,
    yearlyPrice: 107,
  },
};

export const AI_LIMITS = {
  free:    { textRequests: 0,   imageRequests: 0,  pdfReports: 0  },
  pro:     { textRequests: 20,  imageRequests: 0,  pdfReports: 0  },
  premium: { textRequests: 100, imageRequests: 30, pdfReports: 10 },
} as const;

export const FREE_LIMITS = {
  dailyTasks:          5,
  habits:              3,
  monthlyTransactions: 30,
  notes:               10,
  banks:               1,
} as const;

export const TRIAL_DAYS = 7;

export const priceToNanotons = (usd: number, tonUsdRate: number): string => {
  const tonAmount = usd / tonUsdRate;
  const nanotons = Math.round(tonAmount * 1e9);
  return nanotons.toString();
};

export const priceToUsdtUnits = (usd: number): string => {
  return Math.round(usd * 1e6).toString();
};

export interface Subscription {
  id: string;
  userId: string;
  plan: PlanType;
  trialPlan?: PlanType;
  period: SubscriptionPeriod;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string;
  /** Paid-through time in ms; written by the server next to (or instead of) endDate. */
  endDateMs?: number;
  /** Paid-through time as a Firestore Timestamp (TON and admin-granted subscriptions). */
  expiresAt?: { toMillis: () => number } | null;
  trialEndDate?: string;
  walletAddress?: string;
  paymentMethod: PaymentCurrency;
  createdAt: string;
  updatedAt: string;
}

export const calcEndDate = (startDate: Date, period: SubscriptionPeriod): string => {
  const end = new Date(startDate);
  if (period === 'month') {
    end.setMonth(end.getMonth() + 1);
  } else {
    end.setFullYear(end.getFullYear() + 1);
  }
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
};

// When the paid period ends, read the way the server reads it
// (api/_lib/subscription/plan.js: endDateMs, then expiresAt) and only then the
// ISO endDate. Some server paths (TON, admin grants) write endDateMs/expiresAt
// without — or without updating — endDate. NaN when the document has none.
export const getSubscriptionEndMs = (subscription: Subscription): number => {
  if (typeof subscription.endDateMs === 'number' && Number.isFinite(subscription.endDateMs) && subscription.endDateMs > 0) {
    return subscription.endDateMs;
  }
  const expiresMs = subscription.expiresAt?.toMillis?.();
  if (typeof expiresMs === 'number' && Number.isFinite(expiresMs) && expiresMs > 0) return expiresMs;
  return subscription.endDate ? new Date(subscription.endDate).getTime() : NaN;
};

export const isSubscriptionActive = (subscription: Subscription): boolean => {
  if (subscription.status !== 'active') return false;
  return getSubscriptionEndMs(subscription) > Date.now();
};

export const isInTrial = (sub: Subscription): boolean => {
  if (!sub.trialEndDate) return false;
  return new Date(sub.trialEndDate) > new Date();
};

export const getActivePlan = (sub: Subscription | null): PlanType => {
  if (!sub) return 'free';
  if (isInTrial(sub)) return sub.trialPlan ?? 'premium';
  if (!isSubscriptionActive(sub)) return 'free';
  return sub.plan;
};

// Whether the "start the free trial" offer may be shown. POST /api/payment/trial
// refuses whenever a subscriptions/{uid} document exists (an active or past
// trial, a paid plan), so the offer is shown only once that document is known
// to be absent — never while it is still loading.
export const canOfferTrial = (sub: Subscription | null, subscriptionLoaded: boolean): boolean =>
  subscriptionLoaded && sub === null;

export const trialDaysRemaining = (sub: Subscription): number => {
  if (!sub.trialEndDate) return 0;
  const ms = new Date(sub.trialEndDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
};

/** What the app shows as the user's plan: header badge, Settings, onboarding. */
export type PlanDisplay =
  | { kind: 'none' }
  | { kind: 'trial'; plan: PaidPlan; daysLeft: number }
  | { kind: 'paid'; plan: PaidPlan };

// Decided the way the server decides (api/_lib/subscription/plan.js,
// resolveActivePlan): a paid plan still running wins over a trial recorded in
// the same document (a plan bought during the trial); a trial shows only on a
// free document whose trial is still running; a document that is not 'active'
// or whose time is over shows nothing. Display only: what the user may use is
// decided by the server and, for the app's own limits, by getActivePlan above
// — neither is changed by this.
export const getPlanDisplay = (sub: Subscription | null): PlanDisplay => {
  if (!sub || sub.status !== 'active') return { kind: 'none' };
  if (sub.plan === 'pro' || sub.plan === 'premium') {
    return isSubscriptionActive(sub) ? { kind: 'paid', plan: sub.plan } : { kind: 'none' };
  }
  if (sub.plan === 'free' && (sub.trialPlan === 'pro' || sub.trialPlan === 'premium') && isInTrial(sub)) {
    return { kind: 'trial', plan: sub.trialPlan, daysLeft: trialDaysRemaining(sub) };
  }
  return { kind: 'none' };
};

// Days remaining in the current billing window (trial takes precedence over endDate)
export const getDaysRemaining = (sub: Subscription): number => {
  const refMs = isInTrial(sub) ? new Date(sub.trialEndDate ?? sub.endDate).getTime() : getSubscriptionEndMs(sub);
  const ms = refMs - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
};

export const SBP_PRICES: Record<PaidPlan, Record<SubscriptionPeriod, number>> = {
  pro:     { month: 750,  year: 7200  },
  premium: { month: 1000, year: 9600  },
};

// Enma treasury wallet for receiving subscription payments
export const ENMA_WALLET_ADDRESS = 'UQAmqtbkNs6OYMhQl83f_iesYhBrJJTPa7-wuIZCLEbSDplH';
