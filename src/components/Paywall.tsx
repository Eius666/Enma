import React from 'react';
import type { PlanType } from '../subscription';
import './Paywall.css';

interface PaywallProps {
  featureName: string;
  language: 'en' | 'ru';
  currentPlan?: PlanType;
  onClose: () => void;
  onUpgrade: () => void;
}

const T = {
  en: {
    titleFree:   'Upgrade Required',
    titlePro:    'Premium Feature',
    textFree:    'Upgrade to Pro or Premium to use',
    textPro:     'Available in Premium. Upgrade to access',
    upgradeFree: 'See Plans',
    upgradePro:  'Upgrade to Premium',
    cancel:      'Maybe later',
  },
  ru: {
    titleFree:   'Нужен апгрейд',
    titlePro:    'Функция Premium',
    textFree:    'Перейдите на Pro или Premium, чтобы использовать',
    textPro:     'Доступно в Premium. Обновите тариф, чтобы использовать',
    upgradeFree: 'Посмотреть тарифы',
    upgradePro:  'Перейти на Premium',
    cancel:      'Позже',
  },
};

interface LimitBannerProps {
  message: string;
  onUpgrade: () => void;
  upgradeLabel: string;
}

export const LimitBanner: React.FC<LimitBannerProps> = ({ message, onUpgrade, upgradeLabel }) => (
  <div className="limit-banner">
    <span className="limit-banner__text">{message}</span>
    <button className="limit-banner__btn" onClick={onUpgrade} type="button">
      {upgradeLabel}
    </button>
  </div>
);

const Paywall: React.FC<PaywallProps> = ({
  featureName,
  language,
  currentPlan = 'free',
  onClose,
  onUpgrade,
}) => {
  const t   = T[language];
  const isPro = currentPlan === 'pro';

  const title   = isPro ? t.titlePro   : t.titleFree;
  const text    = isPro ? t.textPro    : t.textFree;
  const btnText = isPro ? t.upgradePro : t.upgradeFree;

  return (
    <div className="paywall-overlay" onClick={onClose}>
      <div className="paywall-modal" onClick={e => e.stopPropagation()}>
        <div className="paywall-modal__icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#a29bfe" stroke="#a29bfe" strokeWidth="0" />
          </svg>
        </div>
        <h3 className="paywall-modal__title">{title}</h3>
        <p className="paywall-modal__text">
          {text}{' '}
          <span className="paywall-modal__feature-name">{featureName}</span>
        </p>
        <button className="paywall-modal__upgrade-btn" onClick={onUpgrade} type="button">
          {btnText}
        </button>
        <button className="paywall-modal__close-btn" onClick={onClose} type="button">
          {t.cancel}
        </button>
      </div>
    </div>
  );
};

export default Paywall;
