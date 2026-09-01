import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTonConnectUI, useTonAddress, useTonWallet } from '@tonconnect/ui-react';
import {
  PLANS,
  SBP_PRICES,
  ENMA_WALLET_ADDRESS,
  priceToNanotons,
  priceToUsdtUnits,
  priceToStars,
  calcEndDate,
  isSubscriptionActive,
  isInTrial,
  getActivePlan,
  Subscription,
  PaidPlan,
  SubscriptionPeriod,
} from '../subscription';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';
import './Subscription.css';

// ── Types ──────────────────────────────────────────────────────────────────────

type PayMethod  = 'stars' | 'ton' | 'usdt' | 'sbp';
type PayStatus  = 'idle' | 'sending' | 'verifying' | 'verified' | 'error';
type SelectedPlan = PaidPlan | 'free';

interface SubscriptionPanelProps {
  language: 'en' | 'ru';
  user: User | null;
  subscription: Subscription | null;
  onSubscriptionChange: (sub: Subscription | null) => void;
  onClose?: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const METHODS: { id: PayMethod; icon: string; label: string; sub: Record<string, string> }[] = [
  { id: 'sbp',   icon: '💳', label: 'СБП',   sub: { en: 'Bank card',    ru: 'Банк. карта'  } },
  // TODO: вернуть после фикса Stars webhook
  // { id: 'stars', icon: '⭐', label: 'Stars', sub: { en: 'Via Telegram', ru: 'Через Telegram'} },
  { id: 'ton',   icon: '💎', label: 'TON',   sub: { en: 'Crypto',       ru: 'Криптовалюта' } },
  { id: 'usdt',  icon: '💲', label: 'USDT',  sub: { en: 'Stablecoin',   ru: 'Стейблкоин'  } },
];

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    title:           'Enma Plans',
    subtitle:        'Choose the right plan for you',
    trial:           '7 days Premium free for new users',
    trialTitle:      '7 days Premium free',
    trialSub:        'For new users',
    trialBtn:        'Start trial',
    activeSub:       'Active until {date}',
    free:            'Free',
    pro:             'Pro',
    premium:         'Premium',
    currentPlan:     'Current plan',
    monthly:         '1 month',
    yearly:          '1 year',
    saveLabel:       'Save 20%',
    pay:             'Pay',
    connectFirst:    'Connect wallet first',
    processing:      'Processing…',
    verifying:       'Waiting for confirmation…',
    verified:        'Confirmed! Plan is active',
    paymentError:    'Payment failed. Try again.',
    promoPlaceholder:      'Promo code',
    promoApply:            'Apply',
    promoValid:            '{percent}% off',
    promoInvalid:          'Code not found or expired',
    promoErrorNotFound:    'Code not found or expired',
    promoErrorExhausted:   'Activation limit reached',
    promoErrorAlreadyUsed: "You've already used this code",
    promoErrorInactive:    'Code is no longer active',
    referralPlaceholder:      'Referral code',
    referralApply:            'Apply',
    referralValid:            'Code {code} applied. {percent}% discount',
    referralValidMaxDiscount: 'Max discount {percent}% applied. Influencer gets bonus.',
    referralInvalid:          'Referral code not found',
    referralErrorInactive:    'Referral code is inactive',
    referralErrorAlreadyReferred: 'You already have a referrer',
    perMonth:        '/mo',
    perYear:         '/yr',
    freePlanTitle:   'Free plan',
    freePlanText:    'Basic features with limits',
    whatIncluded:     "What's included",
    upgradePrompt:    'Upgrade to unlock full access',
    upgradeFromPro:   'You have Pro. Upgrade to Premium for AI images and chat.',
    alreadyPremium:   "You're on the top plan!",
    tableTitle:       'Plan comparison',
    featCol:         'Feature',
    freeCol:         'Free',
    proCol:          'Pro',
    premiumCol:      'Premium',
    freeList: ['5 tasks/day', '30 transactions/mo', '3 habits', '10 notes', '1 bank'],
    proList:  ['20 AI requests/mo', 'Unlimited transactions', 'Unlimited habits', 'Unlimited notes', 'Multiple banks'],
    premiumList: ['100 AI requests/mo', '30 AI images/mo', '10 PDF reports/mo', 'AI chat', 'Family access (3 users)', 'Priority support'],
    tableRows: [
      { feature: 'AI text requests/mo', free: '0', pro: '20', premium: '100' },
      { feature: 'AI image gen/mo',     free: '0', pro: '0',  premium: '30' },
      { feature: 'PDF reports/mo',      free: '0', pro: '0',  premium: '10' },
      { feature: 'Tasks/day',           free: '5', pro: '∞',  premium: '∞' },
      { feature: 'Transactions/mo',     free: '30',pro: '∞',  premium: '∞' },
      { feature: 'Habits',              free: '3', pro: '∞',  premium: '∞' },
      { feature: 'Notes',               free: '10',pro: '∞',  premium: '∞' },
      { feature: 'Banks',               free: '1', pro: '∞',  premium: '∞' },
      { feature: 'AI chat',             free: '—', pro: '—',  premium: '+' },
      { feature: 'Family access',       free: '—', pro: '—',  premium: '+' },
    ],
  },
  ru: {
    title:           'Тарифы Enma',
    subtitle:        'Выберите подходящий план',
    trial:           '7 дней Premium бесплатно для новых пользователей',
    trialTitle:      '7 дней Premium бесплатно',
    trialSub:        'Для новых пользователей',
    trialBtn:        'Начать пробный период',
    activeSub:       'Активна до {date}',
    free:            'Free',
    pro:             'Pro',
    premium:         'Premium',
    currentPlan:     'Текущий план',
    monthly:         '1 месяц',
    yearly:          '1 год',
    saveLabel:       'Экономия 20%',
    pay:             'Оплатить',
    connectFirst:    'Подключите кошелёк',
    processing:      'Обработка…',
    verifying:       'Ожидаем подтверждение…',
    verified:        'Оплата прошла! Тариф активирован',
    paymentError:    'Не удалось. Попробуйте ещё раз.',
    promoPlaceholder:      'Промокод',
    promoApply:            'Применить',
    promoValid:            'Скидка {percent}%',
    promoInvalid:          'Промокод не найден или недействителен',
    promoErrorNotFound:    'Промокод не найден или недействителен',
    promoErrorExhausted:   'Лимит активаций исчерпан',
    promoErrorAlreadyUsed: 'Вы уже использовали этот промокод',
    promoErrorInactive:    'Промокод недействителен',
    referralPlaceholder:      'Реферальный код',
    referralApply:            'Применить',
    referralValid:            'Код {code} применён. Скидка {percent}%',
    referralValidMaxDiscount: 'Применена максимальная скидка {percent}%. Инфлюенсер получит бонус.',
    referralInvalid:          'Реферальный код не найден',
    referralErrorInactive:    'Реферальный код неактивен',
    referralErrorAlreadyReferred: 'У вас уже есть реферер',
    perMonth:        '/мес',
    perYear:         '/год',
    freePlanTitle:   'Бесплатный тариф',
    freePlanText:    'Базовые функции с ограничениями',
    whatIncluded:     'Что входит',
    upgradePrompt:    'Обновите план для полного доступа',
    upgradeFromPro:   'Вы на Pro. Обновитесь до Premium для AI-изображений и чата.',
    alreadyPremium:   'Вы уже на максимальном тарифе!',
    tableTitle:       'Сравнение тарифов',
    featCol:         'Функция',
    freeCol:         'Free',
    proCol:          'Pro',
    premiumCol:      'Premium',
    freeList: ['5 задач/день', '30 транзакций/мес', '3 привычки', '10 заметок', '1 банк'],
    proList:  ['20 AI-запросов/мес', 'Безлимит транзакций', 'Безлимит привычек', 'Безлимит заметок', 'Несколько банков'],
    premiumList: ['100 AI-запросов/мес', '30 AI-изображений/мес', '10 PDF-отчётов/мес', 'AI-чат', 'Семейный доступ (3 чел.)', 'Приоритетная поддержка'],
    tableRows: [
      { feature: 'AI-запросы/мес',        free: '0',  pro: '20', premium: '100' },
      { feature: 'AI-изображения/мес',    free: '0',  pro: '0',  premium: '30'  },
      { feature: 'PDF-отчёты/мес',        free: '0',  pro: '0',  premium: '10'  },
      { feature: 'Задачи/день',           free: '5',  pro: '∞',  premium: '∞'   },
      { feature: 'Транзакции/мес',        free: '30', pro: '∞',  premium: '∞'   },
      { feature: 'Привычки',              free: '3',  pro: '∞',  premium: '∞'   },
      { feature: 'Заметки',              free: '10', pro: '∞',  premium: '∞'   },
      { feature: 'Банки',                free: '1',  pro: '∞',  premium: '∞'   },
      { feature: 'AI-чат',               free: '—',  pro: '—',  premium: '+'   },
      { feature: 'Семейный доступ',       free: '—',  pro: '—',  premium: '+'   },
    ],
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const SubscriptionPanel: React.FC<SubscriptionPanelProps> = ({
  language,
  user,
  subscription,
  onSubscriptionChange,
}) => {
  const t = T[language];

  const [tonConnectUI] = useTonConnectUI();
  const userAddress    = useTonAddress();
  const wallet         = useTonWallet();

  const effectivePlan = getActivePlan(subscription ?? null);
  const isActive      = subscription && (isSubscriptionActive(subscription) || isInTrial(subscription));
  const activePlan    = isActive ? effectivePlan : null;

  const [plan,   setPlan]   = useState<SelectedPlan>(activePlan ?? 'free');
  const [period, setPeriod] = useState<SubscriptionPeriod>('month');
  const [method, setMethod] = useState<PayMethod>('sbp');

  const [tonUsdRate,      setTonUsdRate]      = useState(5.0);
  const [promoInput,      setPromoInput]      = useState('');
  const [promoCode,       setPromoCode]       = useState('');
  const [promoDiscount,   setPromoDiscount]   = useState(0);
  const [promoMsg,        setPromoMsg]        = useState<{ type: 'valid'|'invalid'; text: string }|null>(null);
  const [promoChecking,   setPromoChecking]   = useState(false);

  const [referralInput,   setReferralInput]   = useState('');
  const [referralCode,    setReferralCode]    = useState('');
  const [referralDiscount, setReferralDiscount] = useState(0);
  const [referralMsg,     setReferralMsg]     = useState<{ type: 'valid'|'invalid'; text: string }|null>(null);
  const [referralChecking, setReferralChecking] = useState(false);
  const [payStatus,       setPayStatus]       = useState<PayStatus>('idle');
  const [trialLoading,    setTrialLoading]    = useState(false);
  const [trialUsed,       setTrialUsed]       = useState(true);

  const pollRef   = useRef<ReturnType<typeof setInterval>|null>(null);
  const payBtnRef = useRef<HTMLButtonElement>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, 'users', user.uid)).then(snap => {
      if (snap.exists()) setTrialUsed(snap.data().trialUsed === true);
      else setTrialUsed(false);
    }).catch(() => setTrialUsed(false));
  }, [user]);

  useEffect(() => {
    if (method !== 'ton' && method !== 'usdt') return;
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')
      .then(r => r.json())
      .then(d => { if (d['the-open-network']?.usd) setTonUsdRate(d['the-open-network'].usd); })
      .catch(() => {});
  }, [method]);

  // ── Price ──────────────────────────────────────────────────────────────────

  // Discounts don't stack — take the maximum
  const effectiveDiscount = Math.max(promoDiscount, referralDiscount);
  const discountMult      = effectiveDiscount > 0 ? (1 - effectiveDiscount / 100) : 1;
  const paidPlan          = plan === 'free' ? null : plan as PaidPlan;

  const baseUsd = paidPlan
    ? (period === 'month' ? PLANS[paidPlan].monthlyPrice : PLANS[paidPlan].yearlyPrice)
    : 0;

  const displayPrice = useMemo(() => {
    if (!paidPlan) return '0 ₽';
    const sbp = SBP_PRICES[paidPlan][period];
    const usd = baseUsd * discountMult;
    switch (method) {
      case 'ton':   return `${(usd / tonUsdRate).toFixed(2)} TON`;
      case 'usdt':  return `${usd.toFixed(2)} USDT`;
      case 'stars': return `${priceToStars(usd).toLocaleString()} ⭐`;
      case 'sbp':   return `${Math.round(sbp * discountMult)} ₽`;
    }
  }, [method, discountMult, tonUsdRate, baseUsd, paidPlan, period]);

  const originalPriceDisplay = useMemo(() => {
    if (!paidPlan || !effectiveDiscount) return null;
    const sbp = SBP_PRICES[paidPlan][period];
    switch (method) {
      case 'ton':   return `${(baseUsd / tonUsdRate).toFixed(2)} TON`;
      case 'usdt':  return `${baseUsd.toFixed(2)} USDT`;
      case 'stars': return `${priceToStars(baseUsd).toLocaleString()} ⭐`;
      case 'sbp':   return `${sbp} ₽`;
    }
  }, [method, effectiveDiscount, tonUsdRate, baseUsd, paidPlan, period]);

  const periodLabel = period === 'month' ? t.perMonth : t.perYear;

  // ── Promo ──────────────────────────────────────────────────────────────────

  const handleApplyPromo = useCallback(async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoChecking(true);
    setPromoMsg(null);
    try {
      const uidParam = user?.uid ? `&userId=${encodeURIComponent(user.uid)}` : '';
      const resp = await fetch(`/api/payment/create?validatePromo=${encodeURIComponent(code)}${uidParam}`);
      const data = await resp.json();
      if (data.valid) {
        setPromoCode(code);
        setPromoDiscount(data.discountPercent);
        setPromoMsg({ type: 'valid', text: t.promoValid.replace('{percent}', String(data.discountPercent)) });
      } else {
        setPromoCode('');
        setPromoDiscount(0);
        const errorMsg =
          data.error === 'exhausted'    ? t.promoErrorExhausted :
          data.error === 'already_used' ? t.promoErrorAlreadyUsed :
          data.error === 'inactive'     ? t.promoErrorInactive :
          t.promoErrorNotFound;
        setPromoMsg({ type: 'invalid', text: errorMsg });
      }
    } catch {
      setPromoMsg({ type: 'invalid', text: t.promoErrorNotFound });
    } finally {
      setPromoChecking(false);
    }
  }, [promoInput, user, t]);

  const resetPromo = () => {
    setPromoCode(''); setPromoDiscount(0); setPromoInput(''); setPromoMsg(null);
  };

  const handleApplyReferral = useCallback(async () => {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    setReferralChecking(true);
    setReferralMsg(null);
    try {
      const resp = await fetch('/api/ai/referralValidate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, userId: user?.uid || null }),
      });
      const data = await resp.json();
      if (data.valid) {
        setReferralCode(code);
        setReferralDiscount(data.discountPercent);
        // If promo gives a better discount, inform the user
        const appliedDiscount = Math.max(data.discountPercent, promoDiscount);
        const isMaxFromPromo  = promoDiscount >= data.discountPercent && promoDiscount > 0;
        const msg = isMaxFromPromo
          ? t.referralValidMaxDiscount.replace('{percent}', String(appliedDiscount))
          : t.referralValid.replace('{code}', code).replace('{percent}', String(data.discountPercent));
        setReferralMsg({ type: 'valid', text: msg });
      } else {
        setReferralCode('');
        setReferralDiscount(0);
        const errorMsg =
          data.error === 'referral_inactive'    ? t.referralErrorInactive :
          data.error === 'already_referred'     ? t.referralErrorAlreadyReferred :
          t.referralInvalid;
        setReferralMsg({ type: 'invalid', text: errorMsg });
      }
    } catch {
      setReferralMsg({ type: 'invalid', text: t.referralInvalid });
    } finally {
      setReferralChecking(false);
    }
  }, [referralInput, user, promoDiscount, t]);

  const resetReferral = () => {
    setReferralCode(''); setReferralDiscount(0); setReferralInput(''); setReferralMsg(null);
  };

  // ── Trial ──────────────────────────────────────────────────────────────────

  const handleTrial = async () => {
    if (!user || trialLoading) return;
    setTrialLoading(true);
    try {
      const res = await fetch('/api/payment/trial', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: user.uid }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const subSnap = await getDoc(doc(db, 'subscriptions', user.uid));
        if (subSnap.exists()) {
          const sub = subSnap.data() as Subscription;
          onSubscriptionChange(sub);
        }
        setTrialUsed(true);
      }
    } catch {
      /* ignore */
    } finally {
      setTrialLoading(false);
    }
  };

  // ── Payment ────────────────────────────────────────────────────────────────

  const handlePay = useCallback(async () => {
    if (!user || !paidPlan || payStatus === 'sending' || payStatus === 'verifying') return;
    setPayStatus('sending');

    try {
      if (method === 'stars') {
        const tgStars = (window as Window & { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } }).Telegram?.WebApp;
        const botUrl  = 'https://t.me/EnmaAI_bot';
        if (tgStars?.openTelegramLink) tgStars.openTelegramLink(botUrl);
        else window.open(botUrl, '_blank', 'noopener,noreferrer');
        setPayStatus('idle');
        return;
      }

      if (method === 'ton') {
        if (!wallet) { setPayStatus('idle'); return; }
        const paymentId   = createId();
        const now         = new Date();
        const endDate     = calcEndDate(now, period);
        const discountUsd = baseUsd * discountMult;
        const amountRaw   = priceToNanotons(discountUsd, tonUsdRate);

        await setDoc(doc(db, 'payments', paymentId), {
          id: paymentId, userId: user.uid, plan: paidPlan, period,
          currency: 'ton', amountUsd: discountUsd, amountRaw,
          status: 'pending', senderAddress: userAddress ?? null,
          promoCode:    promoCode    || null, discountPercent: effectiveDiscount,
          referralCode: referralCode || null,
          createdAt: now.toISOString(), updatedAt: serverTimestamp(),
        });

        const result = await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{ address: ENMA_WALLET_ADDRESS, amount: amountRaw, payload: `enma:${paidPlan}:${period}:${paymentId}` }],
        });

        await setDoc(doc(db, 'payments', paymentId), { txHash: result.boc, updatedAt: serverTimestamp() }, { merge: true });
        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/ton/verify?paymentId=${paymentId}`);
            const d = await r.json();
            if (d.status === 'confirmed') {
              stopPoll();
              const newSub: Subscription = {
                id: createId(), userId: user.uid, plan: paidPlan, period,
                status: 'active', startDate: now.toISOString(), endDate,
                walletAddress: userAddress ?? undefined,
                paymentMethod: 'ton', createdAt: now.toISOString(), updatedAt: now.toISOString(),
              };
              onSubscriptionChange(newSub);
              setPayStatus('verified');
              setTimeout(() => setPayStatus('idle'), 5000);
            }
          } catch { /* keep polling */ }
        }, 5000);
        return;
      }

      if (method === 'usdt') {
        if (!wallet) { setPayStatus('idle'); return; }
        const paymentId   = createId();
        const now         = new Date();
        const endDate     = calcEndDate(now, period);
        const discountUsd = baseUsd * discountMult;
        const amountRaw   = priceToUsdtUnits(discountUsd);

        await setDoc(doc(db, 'payments', paymentId), {
          id: paymentId, userId: user.uid, plan: paidPlan, period,
          currency: 'usdt', amountUsd: discountUsd, amountRaw,
          status: 'pending', senderAddress: userAddress ?? null,
          promoCode:    promoCode    || null, discountPercent: effectiveDiscount,
          referralCode: referralCode || null,
          createdAt: now.toISOString(), updatedAt: serverTimestamp(),
        });

        const result = await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{ address: ENMA_WALLET_ADDRESS, amount: '50000000', payload: `enma:${paidPlan}:${period}:${paymentId}:usdt:${amountRaw}` }],
        });

        await setDoc(doc(db, 'payments', paymentId), { txHash: result.boc, updatedAt: serverTimestamp() }, { merge: true });
        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/ton/verify?paymentId=${paymentId}`);
            const d = await r.json();
            if (d.status === 'confirmed') {
              stopPoll();
              const newSub: Subscription = {
                id: createId(), userId: user.uid, plan: paidPlan, period,
                status: 'active', startDate: now.toISOString(), endDate,
                walletAddress: userAddress ?? undefined,
                paymentMethod: 'usdt', createdAt: now.toISOString(), updatedAt: now.toISOString(),
              };
              onSubscriptionChange(newSub);
              setPayStatus('verified');
              setTimeout(() => setPayStatus('idle'), 5000);
            }
          } catch { /* keep polling */ }
        }, 5000);
        return;
      }

      if (method === 'sbp') {
        const resp = await fetch('/api/payment/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.uid, userName: user.email || '',
            plan: paidPlan, period,
            promoCode:    promoCode    || undefined,
            referralCode: referralCode || undefined,
          }),
        });
        const data = await resp.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'No URL');

        const tgWebApp = (window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }).Telegram?.WebApp;
        if (tgWebApp?.openLink) tgWebApp.openLink(data.url);
        else window.open(data.url, '_blank', 'noopener,noreferrer');

        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/payment/create?transactionId=${data.transactionId}&uid=${user.uid}`);
            const d = await r.json();
            if (d.status === 'CONFIRMED') {
              stopPoll();
              try {
                const subSnap = await getDoc(doc(db, 'subscriptions', user.uid));
                if (subSnap.exists()) {
                  const sub = subSnap.data() as Subscription;
                  if (isSubscriptionActive(sub)) onSubscriptionChange(sub);
                }
              } catch { /* onSnapshot will pick it up */ }
              setPayStatus('verified');
              setTimeout(() => setPayStatus('idle'), 5000);
            } else if (d.status === 'CANCELED' || d.status === 'EXPIRED') {
              stopPoll();
              setPayStatus('error');
              setTimeout(() => setPayStatus('idle'), 4000);
            }
          } catch { /* keep polling */ }
        }, 3000);
      }
    } catch (err) {
      console.error('[pay]', err);
      stopPoll();
      setPayStatus('error');
      setTimeout(() => setPayStatus('idle'), 4000);
    }
  }, [method, user, wallet, userAddress, paidPlan, period, promoCode, referralCode, effectiveDiscount, discountMult, baseUsd, tonUsdRate, tonConnectUI, onSubscriptionChange, payStatus, stopPoll]);

  const btnLabel = useMemo(() => {
    if (payStatus === 'sending')   return t.processing;
    if (payStatus === 'verifying') return t.verifying;
    if (payStatus === 'verified')  return t.verified;
    if (payStatus === 'error')     return t.paymentError;
    if ((method === 'ton' || method === 'usdt') && !wallet) return t.connectFirst;
    return `${t.pay} ${displayPrice}${periodLabel}`;
  }, [payStatus, method, wallet, displayPrice, periodLabel, t]);

  const btnDisabled = payStatus === 'sending' || payStatus === 'verifying'
    || ((method === 'ton' || method === 'usdt') && !wallet && payStatus === 'idle');

  const showTrialBanner = !isActive && !trialUsed;
  const showPaymentSection = plan !== 'free';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="subscription-panel">

      {/* Title */}
      <div className="subscription-panel__header">
        <h2 className="subscription-panel__title">{t.title}</h2>
        <p className="subscription-panel__subtitle">{t.subtitle}</p>
      </div>

      {/* Trial banner */}
      {showTrialBanner && (
        <div className="subscription-panel__trial">
          <div className="subscription-panel__trial-body">
            <span className="subscription-panel__trial-title">{t.trialTitle}</span>
            <span className="subscription-panel__trial-sub">{t.trialSub}</span>
          </div>
          <button
            className="subscription-panel__trial-btn"
            onClick={handleTrial}
            disabled={trialLoading}
            type="button"
          >
            {trialLoading ? '…' : t.trialBtn}
          </button>
        </div>
      )}

      {/* Active subscription banner */}
      {isActive && (
        <div className="subscription-panel__active">
          <div className="subscription-panel__active-body">
            <span className="subscription-panel__active-dot" />
            <span className="subscription-panel__active-text">
              {t.activeSub.replace(
                '{date}',
                new Date(subscription.endDate).toLocaleDateString(
                  language === 'ru' ? 'ru-RU' : 'en-US',
                  { day: 'numeric', month: 'long', year: 'numeric' }
                )
              )}
            </span>
          </div>
          <button
            type="button"
            className="subscription-panel__renew-btn"
            onClick={() => payBtnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            {language === 'ru' ? 'Продлить' : 'Renew'}
          </button>
        </div>
      )}

      {/* Plan toggle */}
      <div className="subscription-panel__plan-toggle">
        {(['free', 'pro', 'premium'] as SelectedPlan[]).map(p => {
          const label: Record<SelectedPlan, string> = { free: t.free, pro: t.pro, premium: t.premium };
          return (
            <button
              key={p}
              type="button"
              className={[
                'subscription-panel__plan-toggle-btn',
                plan === p ? `subscription-panel__plan-toggle-btn--active-${p}` : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setPlan(p)}
            >
              {label[p]}
              {activePlan === p && <span className="subscription-panel__plan-toggle-dot" />}
            </button>
          );
        })}
      </div>

      {/* Feature list — what's included in the selected plan */}
      <div className="subscription-panel__feature-list">
        <span className="subscription-panel__feature-list-label">{t.whatIncluded}</span>
        {(plan === 'free' ? t.freeList : plan === 'pro' ? t.proList : t.premiumList).map((feature) => (
          <div key={feature} className={`subscription-panel__feature-list-item subscription-panel__feature-list-item--${plan}`}>
            <span className="subscription-panel__feature-list-text">{feature}</span>
          </div>
        ))}
      </div>

      {/* Upgrade context hints */}
      {effectivePlan === 'pro' && plan === 'premium' && (
        <p className="subscription-panel__upgrade-hint">{t.upgradeFromPro}</p>
      )}
      {effectivePlan === 'premium' && isActive && (
        <p className="subscription-panel__upgrade-hint subscription-panel__upgrade-hint--success">
          {t.alreadyPremium}
        </p>
      )}

      {/* Payment section — hidden when Free selected */}
      {showPaymentSection && (
        <>
          {/* Period selector */}
          <div className="subscription-panel__periods">
            {(['month', 'year'] as SubscriptionPeriod[]).map(p => (
              <button
                key={p}
                type="button"
                className={`subscription-panel__period-btn${period === p ? ' subscription-panel__period-btn--active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {p === 'month'
                  ? t.monthly
                  : <>{t.yearly} · <span className="subscription-panel__save-badge">{t.saveLabel}</span></>
                }
              </button>
            ))}
          </div>

          {/* Method selector */}
          <div className="subscription-panel__methods">
            {METHODS.map(m => (
              <button
                key={m.id}
                type="button"
                className={`subscription-panel__method-btn${method === m.id ? ' subscription-panel__method-btn--active' : ''}`}
                onClick={() => { setMethod(m.id); setPayStatus('idle'); stopPoll(); }}
              >
                <span className="subscription-panel__method-icon">{m.icon}</span>
                <span className="subscription-panel__method-label">{m.label}</span>
                <span className="subscription-panel__method-sub">{m.sub[language]}</span>
              </button>
            ))}
          </div>

          {/* Promo code */}
          <div className="subscription-panel__promo">
            {promoCode ? (
              <div className="subscription-panel__promo-applied">
                <span>✓ {promoCode} — {t.promoValid.replace('{percent}', String(promoDiscount))}</span>
                <button type="button" className="subscription-panel__promo-reset" onClick={resetPromo}>✕</button>
              </div>
            ) : (
              <div className="subscription-panel__promo-row">
                <input
                  className="subscription-panel__promo-input"
                  type="text"
                  placeholder={t.promoPlaceholder}
                  value={promoInput}
                  onChange={e => setPromoInput(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') handleApplyPromo(); }}
                />
                <button
                  type="button"
                  className="subscription-panel__promo-apply-btn"
                  onClick={handleApplyPromo}
                  disabled={promoChecking || !promoInput.trim()}
                >
                  {promoChecking ? '…' : t.promoApply}
                </button>
              </div>
            )}
            {promoMsg && !promoCode && (
              <span className={`subscription-panel__promo-msg subscription-panel__promo-msg--${promoMsg.type}`}>
                {promoMsg.text}
              </span>
            )}
          </div>

          {/* Referral code */}
          <div className="subscription-panel__promo">
            {referralCode ? (
              <div className="subscription-panel__promo-applied">
                <span>{referralCode} — {referralDiscount}%</span>
                <button type="button" className="subscription-panel__promo-reset" onClick={resetReferral}>&#x2715;</button>
              </div>
            ) : (
              <div className="subscription-panel__promo-row">
                <input
                  className="subscription-panel__promo-input"
                  type="text"
                  placeholder={t.referralPlaceholder}
                  value={referralInput}
                  onChange={e => setReferralInput(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') handleApplyReferral(); }}
                />
                <button
                  type="button"
                  className="subscription-panel__promo-apply-btn"
                  onClick={handleApplyReferral}
                  disabled={referralChecking || !referralInput.trim()}
                >
                  {referralChecking ? '…' : t.referralApply}
                </button>
              </div>
            )}
            {referralMsg && !referralCode && (
              <span className={`subscription-panel__promo-msg subscription-panel__promo-msg--${referralMsg.type}`}>
                {referralMsg.text}
              </span>
            )}
          </div>

          {/* Price */}
          <div className="subscription-panel__price-block">
            {originalPriceDisplay && (
              <span className="subscription-panel__price-old">{originalPriceDisplay}</span>
            )}
            <span className={`subscription-panel__price-main${effectiveDiscount ? ' subscription-panel__price-main--discounted' : ''}`}>
              {displayPrice}
            </span>
            <span className="subscription-panel__price-period">{periodLabel}</span>
          </div>

          {/* Pay button */}
          <button
            ref={payBtnRef}
            type="button"
            className={`subscription-panel__pay-btn${payStatus === 'verified' ? ' subscription-panel__pay-btn--verified' : ''}`}
            onClick={handlePay}
            disabled={btnDisabled}
          >
            {btnLabel}
          </button>
        </>
      )}


    </div>
  );
};

export default SubscriptionPanel;
