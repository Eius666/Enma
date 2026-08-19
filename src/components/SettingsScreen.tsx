import React, { useState } from 'react';
import {
  FaEnvelope,
  FaSignOutAlt,
  FaGlobeAmericas,
  FaCoins,
  FaMoon,
  FaSun,
  FaChevronRight,
  FaStar,
  FaShieldAlt,
  FaFileContract,
} from 'react-icons/fa';
import { User } from 'firebase/auth';
import type { Subscription } from '../subscription';
import { isSubscriptionActive } from '../subscription';
import WalletConnect from './WalletConnect';
import SubscriptionPanel from './SubscriptionPanel';
import './Settings.css';

// ── Props ─────────────────────────────────────────────────────────────────────

interface SettingsScreenProps {
  language: 'en' | 'ru';
  theme: 'dark' | 'light';
  currency: string;
  user: User | null;
  subscription: Subscription | null;
  ratesStatus: 'idle' | 'loading' | 'error';
  ratesUpdatedAt: string | null;
  banks: string[];
  onLanguageChange: (lang: 'en' | 'ru') => void;
  onCurrencyChange: (currency: string) => void;
  onThemeToggle: () => void;
  onRefreshRates: () => void;
  onSubscriptionChange: (sub: Subscription | null) => void;
  onBanksChange: (banks: string[]) => void;
  onSignOut: () => void;
}

// ── i18n ──────────────────────────────────────────────────────────────────────

const T = {
  en: {
    title: 'Settings',
    groupAccount: 'Account',
    rowEmail: 'Email',
    rowSignOut: 'Sign out',
    groupPrefs: 'Preferences',
    rowLanguage: 'Language',
    rowCurrency: 'Currency',
    rowTheme: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    langEn: 'English',
    langRu: 'Russian',
    groupBanks: 'Banks & Payment Methods',
    noBanks: 'No banks added',
    bankPlaceholder: 'Bank name…',
    addBank: 'Add',
    groupPayment: 'Payment',
    groupLegal: 'Legal',
    rowPrivacy: 'Privacy Policy',
    rowTerms: 'Terms of Service',
    legalNote: 'By using the service you agree to the Privacy Policy and Terms of Service.',
    subFree: 'Free',
    subPro: 'Pro — Active',
    subPremium: 'Premium — Active',
    currencies: {
      USD: 'US Dollar', EUR: 'Euro', RUB: 'Russian Ruble',
      BYN: 'Belarusian Ruble', CNY: 'Chinese Yuan',
    } as Record<string, string>,
    refreshRates: 'Refresh',
    ratesLoading: 'Updating…',
    ratesError: 'Unavailable',
  },
  ru: {
    title: 'Настройки',
    groupAccount: 'Аккаунт',
    rowEmail: 'Email',
    rowSignOut: 'Выйти из аккаунта',
    groupPrefs: 'Предпочтения',
    rowLanguage: 'Язык',
    rowCurrency: 'Валюта',
    rowTheme: 'Тема',
    themeDark: 'Тёмная',
    themeLight: 'Светлая',
    langEn: 'English',
    langRu: 'Русский',
    groupBanks: 'Банки и методы оплаты',
    noBanks: 'Банки не добавлены',
    bankPlaceholder: 'Название банка…',
    addBank: 'Добавить',
    groupPayment: 'Оплата',
    groupLegal: 'Документы',
    rowPrivacy: 'Политика конфиденциальности',
    rowTerms: 'Пользовательское соглашение',
    legalNote: 'Используя сервис, вы соглашаетесь с политикой конфиденциальности и пользовательским соглашением.',
    subFree: 'Бесплатно',
    subPro: 'Pro — Активна',
    subPremium: 'Premium — Активна',
    currencies: {
      USD: 'Доллар США', EUR: 'Евро', RUB: 'Российский рубль',
      BYN: 'Белорусский рубль', CNY: 'Китайский юань',
    } as Record<string, string>,
    refreshRates: 'Обновить',
    ratesLoading: 'Обновление…',
    ratesError: 'Недоступно',
  },
};

const CURRENCIES = ['USD', 'EUR', 'RUB', 'BYN', 'CNY'];

// ── Component ─────────────────────────────────────────────────────────────────

const SettingsScreen: React.FC<SettingsScreenProps> = ({
  language,
  theme,
  currency,
  user,
  subscription,
  ratesStatus,
  banks,
  onLanguageChange,
  onCurrencyChange,
  onThemeToggle,
  onRefreshRates,
  onSubscriptionChange,
  onBanksChange,
  onSignOut,
}) => {
  const t = T[language];

  const [langOpen,     setLangOpen]     = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [bankInput,    setBankInput]    = useState('');

  const userEmail = user?.email ?? '—';
  const subLabel = subscription && isSubscriptionActive(subscription)
    ? (subscription.plan === 'premium' ? t.subPremium : t.subPro)
    : t.subFree;

  const openLink = (url: string) => {
    const tgWebApp = (window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }).Telegram?.WebApp;
    if (tgWebApp?.openLink) {
      tgWebApp.openLink(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="sett-screen">

      {/* ── Title ── */}
      <div className="sett-screen__title">{t.title}</div>

      {/* ━━━ Group: Account ━━━ */}
      <div className="sett-group">

        {/* Email row — read-only */}
        <div className="sett-row">
          <div className="sett-row__icon-wrap">
            {/* SVG envelope — no emoji */}
            <FaEnvelope className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{t.rowEmail}</span>
          <span className="sett-row__value">{userEmail}</span>
        </div>

        <div className="sett-row__divider" />

        {/* Sign out row */}
        <button
          className="sett-row sett-row--danger"
          onClick={onSignOut}
          type="button"
        >
          <div className="sett-row__icon-wrap sett-row__icon-wrap--danger">
            {/* SVG sign-out — no emoji */}
            <FaSignOutAlt className="sett-row__icon" />
          </div>
          <span className="sett-row__label sett-row__label--danger">{t.rowSignOut}</span>
        </button>
      </div>

      {/* ━━━ Group: Preferences ━━━ */}
      <div className="sett-group__label">{t.groupPrefs}</div>
      <div className="sett-group">

        {/* Language row */}
        <button
          className="sett-row"
          onClick={() => { setLangOpen(v => !v); setCurrencyOpen(false); }}
          type="button"
        >
          <div className="sett-row__icon-wrap">
            {/* SVG globe — no emoji */}
            <FaGlobeAmericas className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{t.rowLanguage}</span>
          <span className="sett-row__value">
            {language === 'ru' ? t.langRu : t.langEn}
          </span>
          <FaChevronRight className="sett-row__chevron" />
        </button>

        {langOpen && (
          <div className="sett-picker">
            {(['en', 'ru'] as const).map(lang => (
              <button
                key={lang}
                className={`sett-picker__option${language === lang ? ' sett-picker__option--active' : ''}`}
                onClick={() => { onLanguageChange(lang); setLangOpen(false); }}
                type="button"
              >
                {lang === 'en' ? t.langEn : t.langRu}
              </button>
            ))}
          </div>
        )}

        <div className="sett-row__divider" />

        {/* Currency row */}
        <button
          className="sett-row"
          onClick={() => { setCurrencyOpen(v => !v); setLangOpen(false); }}
          type="button"
        >
          <div className="sett-row__icon-wrap">
            {/* SVG coin — no emoji */}
            <FaCoins className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{t.rowCurrency}</span>
          <span className="sett-row__value">
            {t.currencies[currency] ?? currency}
          </span>
          <FaChevronRight className="sett-row__chevron" />
        </button>

        {currencyOpen && (
          <div className="sett-picker">
            {CURRENCIES.map(c => (
              <button
                key={c}
                className={`sett-picker__option${currency === c ? ' sett-picker__option--active' : ''}`}
                onClick={() => { onCurrencyChange(c); setCurrencyOpen(false); }}
                type="button"
              >
                <span>{c}</span>
                <span className="sett-picker__option-sub">{t.currencies[c] ?? c}</span>
                {ratesStatus === 'loading' && c !== 'USD' && (
                  <span className="sett-picker__option-sub">{t.ratesLoading}</span>
                )}
              </button>
            ))}
            <button
              className="sett-picker__refresh"
              onClick={(e) => { e.stopPropagation(); onRefreshRates(); }}
              type="button"
            >
              {t.refreshRates}
            </button>
          </div>
        )}

        <div className="sett-row__divider" />

        {/* Theme row */}
        <button
          className="sett-row"
          onClick={onThemeToggle}
          type="button"
        >
          <div className="sett-row__icon-wrap">
            {/* SVG sun/moon — no emoji */}
            {theme === 'dark'
              ? <FaMoon className="sett-row__icon" />
              : <FaSun  className="sett-row__icon" />
            }
          </div>
          <span className="sett-row__label">{t.rowTheme}</span>
          <span className="sett-row__value">
            {theme === 'dark' ? t.themeDark : t.themeLight}
          </span>
          {/* Toggle pill — visual only, click on row toggles */}
          <span className={`sett-toggle${theme === 'light' ? ' sett-toggle--on' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {/* ━━━ Group: Banks ━━━ */}
      <div className="sett-group__label">{t.groupBanks}</div>
      <div className="sett-banks">
        {banks.length === 0 && (
          <span className="sett-banks__empty">{t.noBanks}</span>
        )}
        {banks.length > 0 && (
          <div className="sett-banks__chips">
            {banks.map(bank => (
              <span key={bank} className="sett-banks__chip">
                {bank}
                <button
                  className="sett-banks__chip-del"
                  onClick={() => onBanksChange(banks.filter(b => b !== bank))}
                  type="button"
                  aria-label={`Remove ${bank}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="sett-banks__add-row">
          <input
            className="sett-banks__add-input"
            type="text"
            placeholder={t.bankPlaceholder}
            value={bankInput}
            onChange={e => setBankInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const name = bankInput.trim();
                if (name && !banks.includes(name)) {
                  onBanksChange([...banks, name]);
                  setBankInput('');
                }
              }
            }}
          />
          <button
            className="sett-banks__add-btn"
            type="button"
            onClick={() => {
              const name = bankInput.trim();
              if (name && !banks.includes(name)) {
                onBanksChange([...banks, name]);
                setBankInput('');
              }
            }}
          >
            {t.addBank}
          </button>
        </div>
      </div>

      {/* ━━━ Group: Payment ━━━ */}
      <div className="sett-group__label">{t.groupPayment}</div>

      {/* Premium status row — card */}
      <div className="sett-group">
        <div className="sett-row sett-row--tall">
          <div className="sett-row__icon-wrap">
            {/* Subscription star icon — no emoji */}
            <FaStar className="sett-row__icon sett-row__icon--accent" />
          </div>
          <div className="sett-row__body">
            <span className="sett-row__label">Enma Premium</span>
            <span className="sett-row__value sett-row__value--sub">{subLabel}</span>
          </div>
        </div>
      </div>

      {/* TON Wallet button — standalone, no card wrapper */}
      <div className="sett-wallet-btn">
        <WalletConnect language={language} />
      </div>

      {/* Subscription panel (full plan picker) */}
      <div className="sett-subscription-wrap">
        <SubscriptionPanel
          language={language}
          user={user}
          subscription={subscription}
          onSubscriptionChange={onSubscriptionChange}
        />
      </div>

      {/* ━━━ Group: Legal documents ━━━ */}
      <div className="sett-group__label">{t.groupLegal}</div>
      <div className="sett-group">
        <button
          className="sett-row"
          onClick={() => openLink('/privacy.html')}
          type="button"
        >
          <div className="sett-row__icon-wrap">
            <FaShieldAlt className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{t.rowPrivacy}</span>
          <FaChevronRight className="sett-row__chevron" />
        </button>

        <div className="sett-row__divider" />

        <button
          className="sett-row"
          onClick={() => openLink('/terms.html')}
          type="button"
        >
          <div className="sett-row__icon-wrap">
            <FaFileContract className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{t.rowTerms}</span>
          <FaChevronRight className="sett-row__chevron" />
        </button>
      </div>

      <p className="sett-legal-note">{t.legalNote}</p>

    </div>
  );
};

export default SettingsScreen;
