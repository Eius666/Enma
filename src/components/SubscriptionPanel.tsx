import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTonConnectUI, useTonAddress, useTonWallet } from '@tonconnect/ui-react';
import {
  PLANS,
  SBP_MONTHLY_PRICE,
  ENMA_WALLET_ADDRESS,
  priceToNanotons,
  priceToStars,
  calcEndDate,
  isSubscriptionActive,
  Subscription,
} from '../subscription';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';
import './Subscription.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type PayMethod = 'stars' | 'ton' | 'sbp';
type PayStatus = 'idle' | 'sending' | 'verifying' | 'verified' | 'error';

interface SubscriptionPanelProps {
  language: 'en' | 'ru';
  user: User | null;
  subscription: Subscription | null;
  onSubscriptionChange: (sub: Subscription | null) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const METHODS: { id: PayMethod; icon: string; label: string; sub: Record<string, string> }[] = [
  { id: 'sbp',   icon: '💳', label: 'СБП',   sub: { en: 'Bank / SBP',      ru: 'Карта / СБП' } },
  { id: 'ton',   icon: '💎', label: 'TON',   sub: { en: 'Crypto',           ru: 'Криптовалюта' } },
  { id: 'stars', icon: '⭐', label: 'Stars', sub: { en: 'Via Telegram',     ru: 'Через Telegram' } },
];

const PRO_USD = PLANS.pro.monthlyPrice; // $10

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    title:           'Enma Premium',
    subtitle:        'Unlimited AI assistant · 30 days',
    activeSub:       'Active until {date}',
    pay:             'Pay',
    connectFirst:    'Connect wallet first',
    processing:      'Processing…',
    verifying:       'Waiting for confirmation…',
    verified:        'Confirmed! Pro is active 🎉',
    paymentError:    'Payment failed. Try again.',
    promoPlaceholder:'Promo code',
    promoApply:      'Apply',
    promoValid:      '{percent}% off',
    promoInvalid:    'Code not found or expired',
    perMonth:        '/mo',
  },
  ru: {
    title:           'Enma Premium',
    subtitle:        'Безлимитный AI-ассистент · 30 дней',
    activeSub:       'Активна до {date}',
    pay:             'Оплатить',
    connectFirst:    'Подключите кошелёк',
    processing:      'Обработка…',
    verifying:       'Ожидаем подтверждение…',
    verified:        'Оплата прошла! Pro активна 🎉',
    paymentError:    'Не удалось. Попробуйте ещё раз.',
    promoPlaceholder:'Промокод',
    promoApply:      'Применить',
    promoValid:      'Скидка {percent}%',
    promoInvalid:    'Промокод не найден или недействителен',
    perMonth:        '/мес',
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

  // Payment method
  const [method, setMethod] = useState<PayMethod>('sbp');

  // TON rate (only needed for TON method display)
  const [tonUsdRate, setTonUsdRate] = useState(5.0);
  useEffect(() => {
    if (method !== 'ton') return;
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

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => stopPoll, []);

  // ── Price calculation ──────────────────────────────────────────────────────

  const discountMult = promoDiscount > 0 ? (1 - promoDiscount / 100) : 1;

  const displayPrice = useMemo(() => {
    const usd = PRO_USD * discountMult;
    switch (method) {
      case 'ton':   return `${(usd / tonUsdRate).toFixed(2)} TON`;
      case 'stars': return `${priceToStars(usd).toLocaleString()} ⭐`;
      case 'sbp':   return `${Math.round(SBP_MONTHLY_PRICE * discountMult)} ₽`;
    }
  }, [method, discountMult, tonUsdRate]);

  const originalPriceDisplay = useMemo(() => {
    if (!promoDiscount) return null;
    switch (method) {
      case 'ton':   return `${(PRO_USD / tonUsdRate).toFixed(2)} TON`;
      case 'stars': return `${priceToStars(PRO_USD).toLocaleString()} ⭐`;
      case 'sbp':   return `${SBP_MONTHLY_PRICE} ₽`;
    }
  }, [method, promoDiscount, tonUsdRate]);

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
      // ── Stars (stub) ──────────────────────────────────────────────────────
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
        const endDate     = calcEndDate(now, 'month');
        const discountUsd = PRO_USD * discountMult;
        const amountTon   = discountUsd / tonUsdRate;
        const amountRaw   = priceToNanotons(discountUsd, tonUsdRate);

        await setDoc(doc(db, 'payments', paymentId), {
          id:            paymentId,
          userId:        user.uid,
          plan:          'pro',
          period:        'month',
          currency:      'ton',
          amountUsd:     discountUsd,
          amountTon,
          amountRaw,
          status:        'pending',
          senderAddress: userAddress ?? null,
          createdAt:     now.toISOString(),
          updatedAt:     serverTimestamp(),
        });

        const result = await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [{
            address: ENMA_WALLET_ADDRESS,
            amount:  amountRaw,
            payload: `enma:pro:month:${paymentId}`,
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
                id:            createId(),
                userId:        user.uid,
                plan:          'pro',
                period:        'month',
                status:        'active',
                startDate:     now.toISOString(),
                endDate,
                walletAddress: userAddress ?? undefined,
                paymentMethod: 'ton',
                createdAt:     now.toISOString(),
                updatedAt:     now.toISOString(),
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
  }, [method, user, wallet, userAddress, promoCode, discountMult, tonUsdRate, tonConnectUI, onSubscriptionChange, payStatus]);

  // ── Button label ───────────────────────────────────────────────────────────

  const btnLabel = useMemo(() => {
    if (payStatus === 'sending')   return t.processing;
    if (payStatus === 'verifying') return t.verifying;
    if (payStatus === 'verified')  return t.verified;
    if (payStatus === 'error')     return t.paymentError;
    if (method === 'ton' && !wallet) return t.connectFirst;
    return `${t.pay} ${displayPrice}${t.perMonth}`;
  }, [payStatus, method, wallet, displayPrice, t]);

  const isActive = subscription && isSubscriptionActive(subscription);
  const btnDisabled = payStatus === 'sending' || payStatus === 'verifying'
    || (method === 'ton' && !wallet && payStatus === 'idle');

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="subscription-panel">

      {/* Title */}
      <div className="subscription-panel__header">
        <h2 className="subscription-panel__title">{t.title}</h2>
        <p className="subscription-panel__subtitle">{t.subtitle}</p>
      </div>

      {/* Active subscription badge */}
      {isActive && (
        <div className="subscription-panel__active">
          <span className="subscription-panel__active-dot" />
          <span>
            {t.activeSub.replace(
              '{date}',
              new Date(subscription.endDate).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US')
            )}
          </span>
        </div>
      )}

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

      {/* TON Connect — only for TON method */}
      {method === 'ton' && !wallet && (
        <div className="subscription-panel__ton-connect-wrap">
          {/* TonConnectButton renders itself via the UI kit */}
        </div>
      )}

      {/* Promo code (always visible) */}
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
        <span className="subscription-panel__price-period">{t.perMonth}</span>
      </div>

      {/* Pay button */}
      <button
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
