import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTonConnectUI, useTonAddress, useTonWallet } from '@tonconnect/ui-react';
import {
  PlanType,
  SubscriptionPeriod,
  PaymentCurrency,
  PLANS,
  ENMA_WALLET_ADDRESS,
  priceToNanotons,
  priceToUsdtUnits,
  priceToStars,
  calcEndDate,
  isSubscriptionActive,
  Subscription,
  Payment,
} from '../subscription';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { User } from 'firebase/auth';

interface SubscriptionPanelProps {
  language: 'en' | 'ru';
  user: User | null;
  subscription: Subscription | null;
  onSubscriptionChange: (sub: Subscription | null) => void;
}

const SBP_PRESETS = [299, 499, 999];

const T = {
  en: {
    title: 'Enma Premium',
    subtitle: 'Unlock advanced features',
    month: '1 month',
    year: '1 year',
    payWith: 'Pay with',
    pay: 'Pay',
    perMonth: '/mo',
    perYear: '/yr',
    youSave: 'Save {percent}%',
    starsNote: 'Stars only for monthly plans',
    connectFirst: 'Connect your wallet first',
    processing: 'Processing...',
    paymentSent: 'Payment sent! Waiting for confirmation...',
    paymentError: 'Payment failed. Try again.',
    activeSub: 'Your subscription is active until {date}',
    sbpTitle: 'Pay via SBP (Russia)',
    sbpSubtitle: 'Fast bank transfer, 30 days Pro',
    sbpCustom: 'Custom amount (₽)',
    sbpPay: 'Pay via SBP',
    sbpWaiting: 'Waiting for payment…',
    sbpConfirmed: 'Payment confirmed! Pro is active 🎉',
    sbpError: 'Failed to create payment. Try again.',
    currentPlan: 'Current plan',
    proList: ['Unlimited projects', 'Advanced analytics', 'Priority support'],
    businessList: [
      'Everything in Pro',
      'Team collaboration',
      'API access',
      'Custom branding',
    ],
  },
  ru: {
    title: 'Enma Premium',
    subtitle: 'Расширенные возможности',
    month: '1 месяц',
    year: '1 год',
    payWith: 'Оплатить в',
    pay: 'Оплатить',
    perMonth: '/мес',
    perYear: '/год',
    youSave: 'Выгода {percent}%',
    starsNote: 'Stars — только для помесячных планов',
    connectFirst: 'Сначала подключите кошелёк',
    processing: 'Обработка...',
    paymentSent: 'Платёж отправлен! Ожидаем подтверждение...',
    paymentError: 'Платёж не прошёл. Попробуйте ещё раз.',
    activeSub: 'Подписка активна до {date}',
    sbpTitle: 'Оплата через СБП',
    sbpSubtitle: 'Быстрый перевод из приложения банка, 30 дней Pro',
    sbpCustom: 'Своя сумма (₽)',
    sbpPay: 'Оплатить через СБП',
    sbpWaiting: 'Ожидание оплаты…',
    sbpConfirmed: 'Платёж подтверждён! Pro активна 🎉',
    sbpError: 'Не удалось создать платёж. Попробуйте ещё раз.',
    currentPlan: 'Текущий план',
    proList: ['Безлимит проектов', 'Расширенная аналитика', 'Приоритетная поддержка'],
    businessList: ['Всё из Pro', 'Совместная работа', 'API-доступ', 'Кастомный брендинг'],
  },
};

const CurrencyLabels: Record<PaymentCurrency, { en: string; ru: string }> = {
  ton: { en: 'TON', ru: 'TON' },
  usdt: { en: 'USDT', ru: 'USDT' },
  stars: { en: 'Stars', ru: 'Stars' },
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const SubscriptionPanel: React.FC<SubscriptionPanelProps> = ({
  language,
  user,
  subscription,
  onSubscriptionChange,
}) => {
  const [tonConnectUI] = useTonConnectUI();
  const userAddress = useTonAddress();
  const wallet = useTonWallet();
  const t = T[language];

  const [selectedPlan, setSelectedPlan] = useState<PlanType>('pro');
  const [selectedPeriod, setSelectedPeriod] = useState<SubscriptionPeriod>('month');
  const [selectedCurrency, setSelectedCurrency] = useState<PaymentCurrency>('ton');
  const [tonUsdRate, setTonUsdRate] = useState(5.0);
  const [paymentStatus, setPaymentStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle'
  );

  const [sbpAmount, setSbpAmount]   = useState<number>(SBP_PRESETS[1]);
  const [sbpCustom, setSbpCustom]   = useState('');
  const [sbpStatus, setSbpStatus]   = useState<'idle' | 'creating' | 'pending' | 'confirmed' | 'error'>('idle');
  const [, setSbpTxId]              = useState<string | null>(null);
  const sbpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isConnected = !!wallet;

  useEffect(() => {
    const fetchRate = async () => {
      try {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd'
        );
        const data = await res.json();
        if (data['the-open-network']?.usd) {
          setTonUsdRate(data['the-open-network'].usd);
        }
      } catch {
        // fall back to default rate
      }
    };
    fetchRate();
  }, []);

  // Stars not supported for yearly plans
  useEffect(() => {
    if (selectedPeriod === 'year' && selectedCurrency === 'stars') {
      setSelectedCurrency('ton');
    }
  }, [selectedPeriod, selectedCurrency]);

  const stopSbpPoll = () => {
    if (sbpPollRef.current) {
      clearInterval(sbpPollRef.current);
      sbpPollRef.current = null;
    }
  };

  useEffect(() => stopSbpPoll, []);

  const handleSbpPay = useCallback(async () => {
    if (!user) return;
    const amount = sbpCustom ? parseInt(sbpCustom, 10) : sbpAmount;
    if (!amount || amount < 1) return;

    setSbpStatus('creating');
    try {
      const resp = await fetch('/api/payment/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: user.uid, amount, userName: user.email || '' }),
      });
      const data = await resp.json();
      if (!data.ok || !data.url) throw new Error(data.error || 'No URL');

      const tgWebApp = (window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }).Telegram?.WebApp;
      if (tgWebApp?.openLink) {
        tgWebApp.openLink(data.url);
      } else {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }

      setSbpTxId(data.transactionId);
      setSbpStatus('pending');

      sbpPollRef.current = setInterval(async () => {
        try {
          const statusResp = await fetch(`/api/payment/create?transactionId=${data.transactionId}&uid=${user.uid}`);
          const statusData = await statusResp.json();
          if (statusData.status === 'CONFIRMED') {
            setSbpStatus('confirmed');
            stopSbpPoll();
            setTimeout(() => setSbpStatus('idle'), 5000);
          } else if (statusData.status === 'CANCELED' || statusData.status === 'EXPIRED') {
            setSbpStatus('error');
            stopSbpPoll();
            setTimeout(() => setSbpStatus('idle'), 4000);
          }
        } catch {
          // keep polling
        }
      }, 3000);
    } catch (err) {
      console.error('[SBP]', err);
      setSbpStatus('error');
      setTimeout(() => setSbpStatus('idle'), 4000);
    }
  }, [user, sbpAmount, sbpCustom]);

  const planConfig = PLANS[selectedPlan];
  const priceUsd =
    selectedPeriod === 'month' ? planConfig.monthlyPrice : planConfig.yearlyPrice;
  const yearlySaving = Math.round(
    (1 - planConfig.yearlyPrice / (planConfig.monthlyPrice * 12)) * 100
  );

  const getDisplayPrice = useCallback((): string => {
    switch (selectedCurrency) {
      case 'ton':
        return (priceUsd / tonUsdRate).toFixed(2);
      case 'usdt':
        return priceUsd.toFixed(2);
      case 'stars':
        return priceToStars(priceUsd).toLocaleString();
    }
  }, [selectedCurrency, priceUsd, tonUsdRate]);

  const handlePay = useCallback(async () => {
    if (!user) return;
    // Stars payment goes through Telegram bot — no TON wallet needed
    if (selectedCurrency === 'stars') {
      window.open('https://t.me/YourArc_bot', '_blank');
      return;
    }
    if (!isConnected) return;
    setPaymentStatus('sending');

    try {
      const now = new Date();
      const endDate = calcEndDate(now, selectedPeriod);
      const paymentId = createId();
      const subscriptionId = createId();

      const payment: Payment = {
        id: paymentId,
        userId: user.uid,
        subscriptionId,
        plan: selectedPlan,
        period: selectedPeriod,
        currency: selectedCurrency,
        amountUsd: priceUsd,
        amountRaw:
          selectedCurrency === 'ton'
            ? priceToNanotons(priceUsd, tonUsdRate)
            : selectedCurrency === 'usdt'
            ? priceToUsdtUnits(priceUsd)
            : priceToStars(priceUsd).toString(),
        status: 'pending',
        senderAddress: userAddress ?? undefined,
        createdAt: now.toISOString(),
      };

      const newSubscription: Subscription = {
        id: subscriptionId,
        userId: user.uid,
        plan: selectedPlan,
        period: selectedPeriod,
        status: 'active',
        startDate: now.toISOString(),
        endDate,
        walletAddress: userAddress ?? undefined,
        paymentMethod: selectedCurrency,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      await setDoc(doc(db, 'payments', paymentId), {
        ...payment,
        updatedAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'subscriptions', subscriptionId), {
        ...newSubscription,
        updatedAt: serverTimestamp(),
      });

      if (selectedCurrency === 'ton' || selectedCurrency === 'usdt') {
        const amountRaw =
          selectedCurrency === 'ton'
            ? priceToNanotons(priceUsd, tonUsdRate)
            : priceToUsdtUnits(priceUsd);

        const transaction = {
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [
            {
              address: ENMA_WALLET_ADDRESS,
              amount: amountRaw,
              payload: `enma:${selectedPlan}:${selectedPeriod}:${paymentId}`,
            },
          ],
        };

        const result = await tonConnectUI.sendTransaction(transaction);

        await setDoc(
          doc(db, 'payments', paymentId),
          {
            txHash: result.boc,
            status: 'confirmed',
            confirmedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }

      onSubscriptionChange(newSubscription);
      setPaymentStatus('sent');
      setTimeout(() => setPaymentStatus('idle'), 3000);
    } catch (error) {
      console.error('Payment failed:', error);
      setPaymentStatus('error');
      setTimeout(() => setPaymentStatus('idle'), 3000);
    }
  }, [
    isConnected,
    user,
    userAddress,
    selectedPlan,
    selectedPeriod,
    selectedCurrency,
    priceUsd,
    tonUsdRate,
    tonConnectUI,
    onSubscriptionChange,
  ]);

  const isActive = subscription && isSubscriptionActive(subscription);
  const isCurrentPlan = isActive && subscription.plan === selectedPlan;

  return (
    <div className="subscription-panel">
      <div className="subscription-panel__header">
        <h2 className="subscription-panel__title">{t.title}</h2>
        <p className="subscription-panel__subtitle">{t.subtitle}</p>
      </div>

      {isActive && (
        <div className="subscription-panel__active">
          <span className="subscription-panel__active-dot" />
          <span>
            {t.activeSub.replace(
              '{date}',
              new Date(subscription.endDate).toLocaleDateString(
                language === 'ru' ? 'ru-RU' : 'en-US'
              )
            )}
          </span>
        </div>
      )}

      <div className="subscription-panel__plans">
        {(Object.keys(PLANS) as PlanType[]).map(planKey => {
          const plan = PLANS[planKey];
          const isActivePlan = isActive && subscription?.plan === planKey;
          return (
            <button
              key={planKey}
              className={`subscription-panel__plan-card${selectedPlan === planKey ? ' subscription-panel__plan-card--selected' : ''}${isActivePlan ? ' subscription-panel__plan-card--active' : ''}`}
              onClick={() => setSelectedPlan(planKey)}
              type="button"
            >
              <span className="subscription-panel__plan-name">{plan.name[language]}</span>
              {isActivePlan && (
                <span className="subscription-panel__plan-badge">{t.currentPlan}</span>
              )}
              <ul className="subscription-panel__plan-features">
                {(planKey === 'pro' ? t.proList : t.businessList).map((feature, i) => (
                  <li key={i}>{feature}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="subscription-panel__periods">
        <button
          className={`subscription-panel__period-btn${selectedPeriod === 'month' ? ' subscription-panel__period-btn--active' : ''}`}
          onClick={() => setSelectedPeriod('month')}
          type="button"
        >
          {t.month}
        </button>
        <button
          className={`subscription-panel__period-btn${selectedPeriod === 'year' ? ' subscription-panel__period-btn--active' : ''}`}
          onClick={() => setSelectedPeriod('year')}
          type="button"
        >
          {t.year}
          <span className="subscription-panel__save-badge">
            {t.youSave.replace('{percent}', String(yearlySaving))}
          </span>
        </button>
      </div>

      <div className="subscription-panel__price">
        <span className="subscription-panel__price-amount">
          {getDisplayPrice()} {CurrencyLabels[selectedCurrency][language]}
        </span>
        <span className="subscription-panel__price-period">
          {selectedPeriod === 'month' ? t.perMonth : t.perYear}
        </span>
      </div>

      <div className="subscription-panel__currencies">
        <span className="subscription-panel__currency-label">{t.payWith}</span>
        <div className="subscription-panel__currency-buttons">
          <button
            className={`subscription-panel__currency-btn${selectedCurrency === 'ton' ? ' subscription-panel__currency-btn--active' : ''}`}
            onClick={() => setSelectedCurrency('ton')}
            type="button"
          >
            TON
          </button>
          <button
            className={`subscription-panel__currency-btn${selectedCurrency === 'usdt' ? ' subscription-panel__currency-btn--active' : ''}`}
            onClick={() => setSelectedCurrency('usdt')}
            type="button"
          >
            USDT
          </button>
          <button
            className={`subscription-panel__currency-btn${selectedCurrency === 'stars' ? ' subscription-panel__currency-btn--active' : ''}`}
            onClick={() => setSelectedCurrency('stars')}
            disabled={selectedPeriod === 'year'}
            title={selectedPeriod === 'year' ? t.starsNote : undefined}
            type="button"
          >
            Stars
          </button>
        </div>
      </div>

      <button
        className={`subscription-panel__pay-btn${isCurrentPlan ? ' subscription-panel__pay-btn--current' : ''}`}
        onClick={handlePay}
        disabled={
          (selectedCurrency !== 'stars' && !isConnected) ||
          !!isCurrentPlan ||
          paymentStatus === 'sending'
        }
        type="button"
      >
        {paymentStatus === 'idle' &&
          (isCurrentPlan
            ? t.currentPlan
            : selectedCurrency === 'stars'
            ? `${t.pay} ${getDisplayPrice()} Stars → Telegram`
            : !isConnected
            ? t.connectFirst
            : `${t.pay} ${getDisplayPrice()} ${CurrencyLabels[selectedCurrency][language]}`)}
        {paymentStatus === 'sending' && t.processing}
        {paymentStatus === 'sent' && t.paymentSent}
        {paymentStatus === 'error' && t.paymentError}
      </button>
      {/* ── SBP section ── */}
      <div className="subscription-panel__sbp">
        <div className="subscription-panel__sbp-header">
          <span className="subscription-panel__sbp-title">{t.sbpTitle}</span>
          <span className="subscription-panel__sbp-subtitle">{t.sbpSubtitle}</span>
        </div>

        <div className="subscription-panel__sbp-presets">
          {SBP_PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              className={`subscription-panel__sbp-preset${sbpAmount === preset && !sbpCustom ? ' subscription-panel__sbp-preset--active' : ''}`}
              onClick={() => { setSbpAmount(preset); setSbpCustom(''); }}
            >
              {preset} ₽
            </button>
          ))}
        </div>

        <input
          className="subscription-panel__sbp-input"
          type="number"
          min="1"
          placeholder={t.sbpCustom}
          value={sbpCustom}
          onChange={e => setSbpCustom(e.target.value)}
        />

        <button
          type="button"
          className="subscription-panel__sbp-btn"
          disabled={sbpStatus === 'creating' || sbpStatus === 'pending'}
          onClick={handleSbpPay}
        >
          {sbpStatus === 'idle'      && t.sbpPay}
          {sbpStatus === 'creating'  && '⏳ …'}
          {sbpStatus === 'pending'   && t.sbpWaiting}
          {sbpStatus === 'confirmed' && t.sbpConfirmed}
          {sbpStatus === 'error'     && t.sbpError}
        </button>
      </div>

    </div>
  );
};

export default SubscriptionPanel;
