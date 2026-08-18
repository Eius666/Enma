// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Enma Subscription & Payment Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type PlanType = 'pro' | 'business';
export type SubscriptionPeriod = 'month' | 'year';
export type PaymentCurrency = 'ton' | 'usdt' | 'stars' | 'sbp';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';
export type PaymentStatus = 'pending' | 'confirmed' | 'failed' | 'refunded';

export interface PlanConfig {
  id: PlanType;
  name: { en: string; ru: string };
  monthlyPrice: number;
  yearlyPrice: number;
}

export const PLANS: Record<PlanType, PlanConfig> = {
  pro: {
    id: 'pro',
    name: { en: 'Pro', ru: 'Про' },
    monthlyPrice: 10,
    yearlyPrice: 120,
  },
  business: {
    id: 'business',
    name: { en: 'Business', ru: 'Бизнес' },
    monthlyPrice: 15,
    yearlyPrice: 180,
  },
};

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
  walletAddress?: string;
  paymentMethod: PaymentCurrency;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  userId: string;
  subscriptionId: string;
  plan: PlanType;
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

export const SBP_PRICES: Record<PlanType, Record<SubscriptionPeriod, number>> = {
  pro:      { month: 1000,  year: 12000 },
  business: { month: 1500,  year: 15000 },
};

// Enma treasury wallet for receiving subscription payments
export const ENMA_WALLET_ADDRESS = 'UQAmqtbkNs6OYMhQl83f_iesYhBrJJTPa7-wuIZCLEbSDplH';
