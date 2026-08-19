// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Enma Subscription & Payment Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type PlanType = 'free' | 'pro' | 'premium';
export type PaidPlan = 'pro' | 'premium';
export type SubscriptionPeriod = 'month' | 'year';
export type PaymentCurrency = 'ton' | 'usdt' | 'stars' | 'sbp';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';
export type PaymentStatus = 'pending' | 'confirmed' | 'failed' | 'refunded';

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

export const DEFAULT_TON_USD_RATE = 5.0;
export const USDT_DECIMALS = 6;
export const TON_DECIMALS = 9;
export const STAR_USD_RATE = 0.013;

export const priceToNanotons = (usd: number, tonUsdRate: number): string => {
  const tonAmount = usd / tonUsdRate;
  const nanotons = Math.round(tonAmount * 1e9);
  return nanotons.toString();
};

export const priceToUsdtUnits = (usd: number): string => {
  return Math.round(usd * 1e6).toString();
};

export const priceToStars = (usd: number): number => {
  return Math.ceil(usd / STAR_USD_RATE);
};

export interface Subscription {
  id: string;
  userId: string;
  plan: PlanType;
  period: SubscriptionPeriod;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string;
  trialEndDate?: string;
  walletAddress?: string;
  paymentMethod: PaymentCurrency;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  userId: string;
  subscriptionId: string;
  plan: PaidPlan;
  period: SubscriptionPeriod;
  currency: PaymentCurrency;
  amountUsd: number;
  amountRaw: string;
  status: PaymentStatus;
  txHash?: string;
  senderAddress?: string;
  createdAt: string;
  confirmedAt?: string;
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

export const isSubscriptionActive = (subscription: Subscription): boolean => {
  if (subscription.status !== 'active') return false;
  return new Date(subscription.endDate) > new Date();
};

export const isInTrial = (sub: Subscription): boolean => {
  if (!sub.trialEndDate) return false;
  return new Date(sub.trialEndDate) > new Date();
};

export const getActivePlan = (sub: Subscription | null): PlanType => {
  if (!sub || !isSubscriptionActive(sub)) return 'free';
  return sub.plan;
};

export const SBP_PRICES: Record<PaidPlan, Record<SubscriptionPeriod, number>> = {
  pro:     { month: 750,  year: 7200  },
  premium: { month: 1000, year: 9600  },
};

// Enma treasury wallet for receiving subscription payments
export const ENMA_WALLET_ADDRESS = 'UQAmqtbkNs6OYMhQl83f_iesYhBrJJTPa7-wuIZCLEbSDplH';
