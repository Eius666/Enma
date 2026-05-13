import React from 'react';
import './styles/settings.css';
import { createT } from '../../i18n/createT';
import { formatDate } from '../../utils/formatDate';
import type { Language, Currency } from './types';

type SettingsPanelProps = {
  language: Language;
  onLanguageChange: (language: Language) => void;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  ratesUpdatedAt: string | null;
  ratesStatus: 'idle' | 'loading' | 'error';
  onRefreshRates: () => void;
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  language,
  onLanguageChange,
  currency,
  onCurrencyChange,
  ratesUpdatedAt,
  ratesStatus,
  onRefreshRates,
}) => {
  const t = createT(language);
  const languageSelectId = 'settings-language';
  const currencySelectId = 'settings-currency';

  const ratesLabel = (): string => {
    if (ratesStatus === 'loading') return t('settings.ratesUpdating');
    if (ratesStatus === 'error') return t('settings.ratesUnavailable');
    if (!ratesUpdatedAt) return t('settings.ratesUnavailable');
    return t('settings.ratesUpdated', {
      date: formatDate(language, new Date(ratesUpdatedAt), 'MMM d, yyyy p'),
    });
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('settings.badge')}</span>
          <h2>{t('settings.title')}</h2>
          <p className="panel-subtitle">{t('settings.subtitle')}</p>
        </div>
      </header>
      <div className="settings-grid">
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <label className="settings-label" htmlFor={languageSelectId}>
                {t('settings.languageLabel')}
              </label>
              <p>{t('settings.languageDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id={languageSelectId}
                value={language}
                onChange={event => onLanguageChange(event.target.value as Language)}
              >
                <option value="en">{t('settings.languageOptionEnglish')}</option>
                <option value="ru">{t('settings.languageOptionRussian')}</option>
              </select>
              <span className="settings-hint">{t('settings.changesApplyInstantly')}</span>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <label className="settings-label" htmlFor={currencySelectId}>
                {t('settings.currencyLabel')}
              </label>
              <p>{t('settings.currencyDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id={currencySelectId}
                value={currency}
                onChange={event => onCurrencyChange(event.target.value as Currency)}
              >
                <option value="USD">{t('settings.currencyOptionUSD')}</option>
                <option value="EUR">{t('settings.currencyOptionEUR')}</option>
                <option value="GBP">{t('settings.currencyOptionGBP')}</option>
                <option value="RUB">{t('settings.currencyOptionRUB')}</option>
              </select>
              <div className="settings-actions">
                <span className="settings-hint">{ratesLabel()}</span>
                <button className="ghost-button" onClick={onRefreshRates} type="button">
                  {t('settings.refreshRates')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
