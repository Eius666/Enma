import React from 'react';
import './Paywall.css';

interface PaywallProps {
  featureName: string;
  language: 'en' | 'ru';
  onClose: () => void;
  onUpgrade: () => void;
}

const T = {
  en: {
    title:      'Premium Feature',
    text:       'Available in Premium. Upgrade your plan to use',
    upgrade:    'Upgrade to Premium',
    cancel:     'Maybe later',
  },
  ru: {
    title:      'Функция Premium',
    text:       'Доступно в Premium. Обновите тариф, чтобы использовать',
    upgrade:    'Перейти на Premium',
    cancel:     'Позже',
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

const Paywall: React.FC<PaywallProps> = ({ featureName, language, onClose, onUpgrade }) => {
  const t = T[language];

  return (
    <div className="paywall-overlay" onClick={onClose}>
      <div className="paywall-modal" onClick={e => e.stopPropagation()}>
        <div className="paywall-modal__icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#a29bfe" stroke="#a29bfe" strokeWidth="0" />
          </svg>
        </div>
        <h3 className="paywall-modal__title">{t.title}</h3>
        <p className="paywall-modal__text">
          {t.text}{' '}
          <span className="paywall-modal__feature-name">{featureName}</span>
        </p>
        <button className="paywall-modal__upgrade-btn" onClick={onUpgrade} type="button">
          {t.upgrade}
        </button>
        <button className="paywall-modal__close-btn" onClick={onClose} type="button">
          {t.cancel}
        </button>
      </div>
    </div>
  );
};

export default Paywall;
