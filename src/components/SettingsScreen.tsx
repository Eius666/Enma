import React, { useEffect, useRef, useState } from 'react';
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
import { isSubscriptionActive, isInTrial, getActivePlan, trialDaysRemaining, AI_LIMITS, FREE_LIMITS } from '../subscription';
import { subscribeAiUsage, subscribeFreeUsage } from '../lib/usageCounters';
import type { FreeUsageSnapshot } from '../lib/usageCounters';
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
    subFree: 'Free plan',
    subPro: 'Pro — Active',
    subPremium: 'Premium — Active',
    subTrial: 'Premium trial — {days} days left',
    aiUsageLabel: 'AI requests remaining',
    aiImageLabel: 'AI images remaining',
    manageSub: 'Manage subscription',
    freeLimitsTitle: 'Free plan usage',
    freeTasksLabel: 'Tasks today',
    freeHabitsLabel: 'Habits',
    freeNotesLabel: 'Notes',
    freeTxLabel: 'Transactions this month',
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
    subFree: 'Бесплатный тариф',
    subPro: 'Pro — Активна',
    subPremium: 'Premium — Активна',
    subTrial: 'Пробный Premium — осталось {days} дн.',
    aiUsageLabel: 'AI-запросы',
    aiImageLabel: 'AI-изображения',
    manageSub: 'Управление подпиской',
    freeLimitsTitle: 'Использование Free',
    freeTasksLabel: 'Задачи сегодня',
    freeHabitsLabel: 'Привычки',
    freeNotesLabel: 'Заметки',
    freeTxLabel: 'Транзакции за месяц',
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
  const [aiTextUsed,   setAiTextUsed]   = useState<number | null>(null);
  const [aiImgUsed,    setAiImgUsed]    = useState<number | null>(null);
  const [freeUsage,    setFreeUsage]    = useState<FreeUsageSnapshot | null>(null);

  const subPanelRef = useRef<HTMLDivElement>(null);

  const userEmail  = user?.email ?? '—';
  const activePlan = getActivePlan(subscription);
  const inTrial    = subscription ? isInTrial(subscription) : false;

  const subLabel = inTrial
    ? t.subTrial.replace('{days}', String(trialDaysRemaining(subscription!)))
    : subscription && isSubscriptionActive(subscription)
      ? (subscription.plan === 'premium' ? t.subPremium : t.subPro)
      : t.subFree;

  const aiLimits    = AI_LIMITS[activePlan];
  const aiTextLimit = aiLimits.textRequests;
  const aiImgLimit  = aiLimits.imageRequests;

  useEffect(() => {
    if (!user || activePlan === 'free') return;
    return subscribeAiUsage(user.uid, u => {
      setAiTextUsed(u.textRequests);
      setAiImgUsed(u.imageRequests);
    });
  }, [user, activePlan]);

  useEffect(() => {
    if (!user || activePlan !== 'free') return;
    return subscribeFreeUsage(user.uid, setFreeUsage);
  }, [user, activePlan]);

  const handleManageSub = () => {
    subPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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

      {/* Subscription status card */}
      <div className="sett-group">
        <div className="sett-row sett-row--tall">
          <div className="sett-row__icon-wrap">
            <FaStar className={`sett-row__icon${activePlan !== 'free' ? ' sett-row__icon--accent' : ''}`} />
          </div>
          <div className="sett-row__body">
            <span className="sett-row__label">Enma {activePlan === 'free' ? '' : activePlan.charAt(0).toUpperCase() + activePlan.slice(1)}</span>
            <span className={`sett-row__value sett-row__value--sub${inTrial ? ' sett-row__value--trial' : ''}`}>{subLabel}</span>
          </div>
          {activePlan !== 'free' && (
            <button
              type="button"
              className="sett-row__manage-btn"
              onClick={handleManageSub}
            >
              {t.manageSub}
            </button>
          )}
        </div>

        {/* AI usage meters — only when plan has AI */}
        {aiTextLimit > 0 && aiTextUsed !== null && (
          <>
            <div className="sett-row__divider" />
            <div className="sett-ai-usage">
              <div className="sett-ai-usage__row">
                <span className="sett-ai-usage__label">{t.aiUsageLabel}</span>
                <span className="sett-ai-usage__count">
                  {Math.max(0, aiTextLimit - aiTextUsed)}/{aiTextLimit}
                </span>
              </div>
              <div className="sett-ai-usage__bar">
                <div
                  className="sett-ai-usage__fill"
                  style={{ width: `${Math.min(100, (aiTextUsed / aiTextLimit) * 100)}%` }}
                />
              </div>
            </div>
          </>
        )}
        {aiImgLimit > 0 && aiImgUsed !== null && (
          <>
            <div className="sett-row__divider" />
            <div className="sett-ai-usage">
              <div className="sett-ai-usage__row">
                <span className="sett-ai-usage__label">{t.aiImageLabel}</span>
                <span className="sett-ai-usage__count">
                  {Math.max(0, aiImgLimit - aiImgUsed)}/{aiImgLimit}
                </span>
              </div>
              <div className="sett-ai-usage__bar">
                <div
                  className="sett-ai-usage__fill sett-ai-usage__fill--image"
                  style={{ width: `${Math.min(100, (aiImgUsed / aiImgLimit) * 100)}%` }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Free plan usage meters — only for free users */}
      {activePlan === 'free' && freeUsage && (
        <div className="sett-group">
          <div className="sett-row sett-row--label-only">
            <span className="sett-ai-usage__label">{t.freeLimitsTitle}</span>
          </div>
          {([
            { label: t.freeTasksLabel,  used: freeUsage.dailyTaskCount,   limit: FREE_LIMITS.dailyTasks          },
            { label: t.freeHabitsLabel, used: freeUsage.habitCount,        limit: FREE_LIMITS.habits              },
            { label: t.freeNotesLabel,  used: freeUsage.noteCount,         limit: FREE_LIMITS.notes               },
            { label: t.freeTxLabel,     used: freeUsage.transactionCount,  limit: FREE_LIMITS.monthlyTransactions },
          ] as const).map(({ label, used, limit }) => (
            <React.Fragment key={label}>
              <div className="sett-row__divider" />
              <div className="sett-ai-usage">
                <div className="sett-ai-usage__row">
                  <span className="sett-ai-usage__label">{label}</span>
                  <span className="sett-ai-usage__count">{used}/{limit}</span>
                </div>
                <div className="sett-ai-usage__bar">
                  <div
                    className="sett-ai-usage__fill"
                    style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
                  />
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* TON Wallet button — standalone, no card wrapper */}
      <div className="sett-wallet-btn">
        <WalletConnect language={language} />
      </div>

      {/* Subscription panel (full plan picker) */}
      <div className="sett-subscription-wrap" ref={subPanelRef}>
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
