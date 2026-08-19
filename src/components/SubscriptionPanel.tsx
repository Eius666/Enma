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
  Subscription,
  PaidPlan,
  SubscriptionPeriod,
} from '../subscription';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';
import './Subscription.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type PayMethod = 'stars' | 'ton' | 'usdt' | 'sbp';
type PayStatus = 'idle' | 'sending' | 'verifying' | 'verified' | 'error';

interface SubscriptionPanelProps {
  language: 'en' | 'ru';
  user: User | null;
  subscription: Subscription | null;
  onSubscriptionChange: (sub: Subscription | null) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const METHODS: { id: PayMethod; icon: string; label: string; sub: Record<string, string> }[] = [
  { id: 'stars', icon: '⭐', label: 'Stars', sub: { en: 'Via Telegram',   ru: 'Через Telegram'   } },
  { id: 'ton',   icon: '💎', label: 'TON',   sub: { en: 'Crypto',         ru: 'Криптовалюта'     } },
  { id: 'usdt',  icon: '💲', label: 'USDT',  sub: { en: 'Stablecoin',     ru: 'Криптодоллар'     } },
  { id: 'sbp',   icon: '💳', label: 'СБП',   sub: { en: 'Bank card',      ru: 'Банк. карта'      } },
];

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    title:           'Enma Plans',
    subtitle:        'Choose the plan that fits you',
    activeSub:       'Active until {date}',
    pro:             'Pro',
    premium:         'Premium',
    currentPlan:     'Current plan',
    monthly:         '1 month',
    yearly:          '1 year',
    saveLabel:       'Save {pct}%',
    pay:             'Pay',
    connectFirst:    'Connect wallet first',
    processing:      'Processing…',
    verifying:       'Waiting for confirmation…',
    verified:        'Confirmed! Plan is active',
    paymentError:    'Payment failed. Try again.',
    promoPlaceholder:'Promo code',
    promoApply:      'Apply',
    promoValid:      '{percent}% off',
    promoInvalid:    'Code not found or expired',
    perMonth:        '/mo',
    perYear:         '/yr',
    proList: [
      '20 AI requests / month',
      'Unlimited transactions',
      'Statistics & analytics',
      'Data export',
      'Savings goals',
      'Multiple banks',
    ],
    premiumList: [
      '100 AI requests / month',
      '30 AI image generations / month',
      '10 AI PDF reports / month',
      'AI chat consultant',
      'Family access (up to 3)',
      'Priority support',
    ],
  },
  ru: {
    title:           'Тарифы Enma',
    subtitle:        'Выберите подходящий план',
    activeSub:       'Активна до {date}',
    pro:             'Pro',
    premium:         'Premium',
    currentPlan:     'Текущий план',
    monthly:         '1 месяц',
    yearly:          '1 год',
    saveLabel:       'Выгода {pct}%',
    pay:             'Оплатить',
    connectFirst:    'Подключите кошелёк',
    processing:      'Обработка…',
    verifying:       'Ожидаем подтверждение…',
    verified:        'Оплата прошла! Тариф активирован',
    paymentError:    'Не удалось. Попробуйте ещё раз.',
    promoPlaceholder:'Промокод',
    promoApply:      'Применить',
    promoValid:      'Скидка {percent}%',
    promoInvalid:    'Промокод не найден или недействителен',
    perMonth:        '/мес',
    perYear:         '/год',
    proList: [
      '20 AI-запросов в месяц',
      'Неограниченные транзакции',
      'Статистика и аналитика',
      'Экспорт данных',
      'Цели накоплений',
      'Несколько банков',
    ],
    premiumList: [
      '100 AI-запросов в месяц',
      '30 AI-генераций изображений',
      '10 AI-отчётов в PDF',
      'AI-чат консультант',
      'Семейный доступ (до 3 чел.)',
      'Приоритетная поддержка',
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

  // TON Connect
  const [tonConnectUI] = useTonConnectUI();
  const userAddress    = useTonAddress();
  const wallet         = useTonWallet();

  // Plan + period
  const [plan,   setPlan]   = useState<PaidPlan>('pro');
  const [period, setPeriod] = useState<SubscriptionPeriod>('month');

  // Payment method
  const [method, setMethod] = useState<PayMethod>('sbp');

  // TON rate (lazy fetch when TON/USDT selected)
  const [tonUsdRate, setTonUsdRate] = useState(5.0);
  useEffect(() => {
    if (method !== 'ton' && method !== 'usdt') return;
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')
      .then(r => r.json())
      .then(d => { if (d['the-open-network']?.usd) setTonUsdRate(d['the-open-network'].usd); })
      .catch(() => {});
  }, [method]);

  // Promo code
  const [promoInput,    setPromoInput]    = useState('');
  const [promoCode,     setPromoCode]     = useState('');
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoMsg,      setPromoMsg]      = useState<{ type: 'valid' | 'invalid'; text: string } | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  // Payment status
  const [payStatus, setPayStatus] = useState<PayStatus>('idle');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const payBtnRef = useRef<HTMLButtonElement>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  // ── Price calculation ──────────────────────────────────────────────────────

  const discountMult = promoDiscount > 0 ? (1 - promoDiscount / 100) : 1;
  const baseUsd = period === 'month' ? PLANS[plan].monthlyPrice : PLANS[plan].yearlyPrice;

  const displayPrice = useMemo(() => {
    const sbp = SBP_PRICES[plan][period];
    const usd = baseUsd * discountMult;
    switch (method) {
      case 'ton':   return `${(usd / tonUsdRate).toFixed(2)} TON`;
      case 'usdt':  return `${usd.toFixed(2)} USDT`;
      case 'stars': return `${priceToStars(usd).toLocaleString()} ⭐`;
      case 'sbp':   return `${Math.round(sbp * discountMult)} ₽`;
    }
  }, [method, discountMult, tonUsdRate, baseUsd, plan, period]);

  const originalPriceDisplay = useMemo(() => {
    if (!promoDiscount) return null;
    const sbp = SBP_PRICES[plan][period];
    switch (method) {
      case 'ton':   return `${(baseUsd / tonUsdRate).toFixed(2)} TON`;
      case 'usdt':  return `${baseUsd.toFixed(2)} USDT`;
      case 'stars': return `${priceToStars(baseUsd).toLocaleString()} ⭐`;
      case 'sbp':   return `${sbp} ₽`;
    }
  }, [method, promoDiscount, tonUsdRate, baseUsd, plan, period]);

  const periodLabel = period === 'month' ? t.perMonth : t.perYear;

  const savePct = Math.round(
    (1 - PLANS[plan].yearlyPrice / (PLANS[plan].monthlyPrice * 12)) * 100
  );

  // ── Promo validation ───────────────────────────────────────────────────────

  const handleApplyPromo = useCallback(async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoChecking(true);
    setPromoMsg(null);
    try {
      const resp = await fetch(`/api/payment/create?validatePromo=${encodeURIComponent(code)}`);
      const data = await resp.json();
      if (data.valid) {
        setPromoCode(code);
        setPromoDiscount(data.discountPercent);
        setPromoMsg({ type: 'valid', text: t.promoValid.replace('{percent}', String(data.discountPercent)) });
      } else {
        setPromoCode('');
        setPromoDiscount(0);
        setPromoMsg({ type: 'invalid', text: t.promoInvalid });
      }
    } catch {
      setPromoMsg({ type: 'invalid', text: t.promoInvalid });
    } finally {
      setPromoChecking(false);
    }
  }, [promoInput, t.promoValid, t.promoInvalid]);

  const resetPromo = () => {
    setPromoCode('');
    setPromoDiscount(0);
    setPromoInput('');
    setPromoMsg(null);
  };

  // ── Payment handler ────────────────────────────────────────────────────────

  const handlePay = useCallback(async () => {
    if (!user || payStatus === 'sending' || payStatus === 'verifying') return;
    setPayStatus('sending');

    try {
      // ── Stars ─────────────────────────────────────────────────────────────
      if (method === 'stars') {
        window.open('https://t.me/YourArc_bot', '_blank');
        setPayStatus('idle');
        return;
      }

      // ── TON ───────────────────────────────────────────────────────────────
      if (method === 'ton') {
        if (!wallet) { setPayStatus('idle'); return; }

        const paymentId   = createId();
        const now         = new Date();
        const endDate     = calcEndDate(now, period);
        const discountUsd = baseUsd * discountMult;
        const amountTon   = discountUsd / tonUsdRate;
        const amountRaw   = priceToNanotons(discountUsd, tonUsdRate);

        await setDoc(doc(db, 'payments', paymentId), {
          id: paymentId, userId: user.uid, plan, period,
          currency: 'ton', amountUsd: discountUsd, amountTon, amountRaw,
          status: 'pending', senderAddress: userAddress ?? null,
          promoCode: promoCode || null, discountPercent: promoDiscount,
          createdAt: now.toISOString(), updatedAt: serverTimestamp(),
        });

        const result = await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{
            address: ENMA_WALLET_ADDRESS,
            amount:  amountRaw,
            payload: `enma:${plan}:${period}:${paymentId}`,
          }],
        });

        await setDoc(doc(db, 'payments', paymentId), {
          txHash: result.boc, updatedAt: serverTimestamp(),
        }, { merge: true });

        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/ton/verify?paymentId=${paymentId}`);
            const d = await r.json();
            if (d.status === 'confirmed') {
              stopPoll();
              const newSub: Subscription = {
                id: createId(), userId: user.uid, plan, period,
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

      // ── USDT ──────────────────────────────────────────────────────────────
      if (method === 'usdt') {
        if (!wallet) { setPayStatus('idle'); return; }

        const paymentId   = createId();
        const now         = new Date();
        const endDate     = calcEndDate(now, period);
        const discountUsd = baseUsd * discountMult;
        const amountRaw   = priceToUsdtUnits(discountUsd);

        await setDoc(doc(db, 'payments', paymentId), {
          id: paymentId, userId: user.uid, plan, period,
          currency: 'usdt', amountUsd: discountUsd, amountRaw,
          status: 'pending', senderAddress: userAddress ?? null,
          promoCode: promoCode || null, discountPercent: promoDiscount,
          createdAt: now.toISOString(), updatedAt: serverTimestamp(),
        });

        const result = await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{
            address: ENMA_WALLET_ADDRESS,
            amount:  '50000000',
            payload: `enma:${plan}:${period}:${paymentId}:usdt:${amountRaw}`,
          }],
        });

        await setDoc(doc(db, 'payments', paymentId), {
          txHash: result.boc, updatedAt: serverTimestamp(),
        }, { merge: true });

        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/ton/verify?paymentId=${paymentId}`);
            const d = await r.json();
            if (d.status === 'confirmed') {
              stopPoll();
              const newSub: Subscription = {
                id: createId(), userId: user.uid, plan, period,
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

      // ── СБП ───────────────────────────────────────────────────────────────
      if (method === 'sbp') {
        const resp = await fetch('/api/payment/create', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            userId:    user.uid,
            userName:  user.email || '',
            plan,
            period,
            promoCode: promoCode || undefined,
          }),
        });
        const data = await resp.json();
        if (!data.ok || !data.url) throw new Error(data.error || 'No URL');

        const tgWebApp = (window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }).Telegram?.WebApp;
        if (tgWebApp?.openLink) {
          tgWebApp.openLink(data.url);
        } else {
          window.open(data.url, '_blank', 'noopener,noreferrer');
        }

        setPayStatus('verifying');

        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch(`/api/payment/create?transactionId=${data.transactionId}&uid=${user.uid}`);
            const d = await r.json();
            if (d.status === 'CONFIRMED') {
              stopPoll();
              // Fetch subscription from Firestore directly and update state
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
  }, [method, user, wallet, userAddress, plan, period, promoCode, promoDiscount, discountMult, baseUsd, tonUsdRate, tonConnectUI, onSubscriptionChange, payStatus, stopPoll]);

  // ── Button label ───────────────────────────────────────────────────────────

  const btnLabel = useMemo(() => {
    if (payStatus === 'sending')   return t.processing;
    if (payStatus === 'verifying') return t.verifying;
    if (payStatus === 'verified')  return t.verified;
    if (payStatus === 'error')     return t.paymentError;
    if ((method === 'ton' || method === 'usdt') && !wallet) return t.connectFirst;
    return `${t.pay} ${displayPrice}${periodLabel}`;
  }, [payStatus, method, wallet, displayPrice, periodLabel, t]);

  const isActive   = subscription && isSubscriptionActive(subscription);
  const activePlan = isActive ? subscription.plan : null;
  const btnDisabled = payStatus === 'sending' || payStatus === 'verifying'
    || ((method === 'ton' || method === 'usdt') && !wallet && payStatus === 'idle');

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="subscription-panel">

      {/* Title */}
      <div className="subscription-panel__header">
        <h2 className="subscription-panel__title">{t.title}</h2>
        <p className="subscription-panel__subtitle">{t.subtitle}</p>
      </div>

      {/* Active subscription block */}
      {isActive && (
        <div className="subscription-panel__active">
          <div className="subscription-panel__active-body">
            <span className="subscription-panel__active-dot" />
            <span className="subscription-panel__active-text">
              {t.activeSub.replace(
                '{date}',
                new Date(subscription.endDate).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' })
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

      {/* Plan selector */}
      <div className="subscription-panel__plans">
        {(['pro', 'premium'] as PaidPlan[]).map(p => (
          <button
            key={p}
            type="button"
            className={[
              'subscription-panel__plan-card',
              plan === p          ? 'subscription-panel__plan-card--selected' : '',
              activePlan === p    ? 'subscription-panel__plan-card--active'   : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setPlan(p)}
          >
            {activePlan === p && (
              <span className="subscription-panel__plan-badge">{t.currentPlan}</span>
            )}
            <span className="subscription-panel__plan-name">
              {p === 'pro' ? t.pro : t.premium}
            </span>
            <ul className="subscription-panel__plan-features">
              {(p === 'pro' ? t.proList : t.premiumList).map(f => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>

      {/* Period selector */}
      <div className="subscription-panel__periods">
        {(['month', 'year'] as SubscriptionPeriod[]).map(p => (
          <button
            key={p}
            type="button"
            className={`subscription-panel__period-btn${period === p ? ' subscription-panel__period-btn--active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {p === 'month' ? t.monthly : `${t.yearly} · ${t.saveLabel.replace('{pct}', String(savePct))}`}
          </button>
        ))}
      </div>

      {/* Method selector — 4 buttons */}
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

      {/* TON Connect — only for TON/USDT */}
      {(method === 'ton' || method === 'usdt') && !wallet && (
        <div className="subscription-panel__ton-connect-wrap" />
      )}

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

      {/* Price */}
      <div className="subscription-panel__price-block">
        {originalPriceDisplay && (
          <span className="subscription-panel__price-old">{originalPriceDisplay}</span>
        )}
        <span className={`subscription-panel__price-main${promoDiscount ? ' subscription-panel__price-main--discounted' : ''}`}>
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

    </div>
  );
};

export default SubscriptionPanel;
