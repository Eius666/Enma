import React from 'react';
import { translate } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import { formatDate } from '../lib/utils';
import type { Currency, Language } from '../types';

type SettingsPanelProps = {
  language: Language;
  onLanguageChange: (language: Language) => void;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  ratesUpdatedAt: string | null;
  ratesStatus: 'idle' | 'loading' | 'error';
  onRefreshRates: () => void;
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  language,
  onLanguageChange,
  currency,
  onCurrencyChange,
  ratesUpdatedAt,
  ratesStatus,
  onRefreshRates
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const ratesLabel = () => {
    if (ratesStatus === 'loading') return t('ratesUpdating');
    if (ratesStatus === 'error') return t('ratesUnavailable');
    if (!ratesUpdatedAt) return t('ratesUnavailable');
    return t('ratesUpdated', { date: formatDate(language, new Date(ratesUpdatedAt), 'MMM d, yyyy p') });
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('settingsBadge')}</span>
          <h2>{t('settingsTitle')}</h2>
          <p className="panel-subtitle">{t('settingsSubtitle')}</p>
        </div>
      </header>
      <div className="settings-grid">
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <label className="settings-label" htmlFor="settings-language">
                {t('languageLabel')}
              </label>
              <p>{t('languageDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id="settings-language"
                value={language}
                onChange={e => onLanguageChange(e.target.value as Language)}
              >
                <option value="en">{t('languageOptionEnglish')}</option>
                <option value="ru">{t('languageOptionRussian')}</option>
              </select>
              <span className="settings-hint">{t('changesApplyInstantly')}</span>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <label className="settings-label" htmlFor="settings-currency">
                {t('currencyLabel')}
              </label>
              <p>{t('currencyDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id="settings-currency"
                value={currency}
                onChange={e => onCurrencyChange(e.target.value as Currency)}
              >
                <option value="USD">{t('currencyOptionUSD')}</option>
                <option value="EUR">{t('currencyOptionEUR')}</option>
                <option value="GBP">{t('currencyOptionGBP')}</option>
                <option value="RUB">{t('currencyOptionRUB')}</option>
              </select>
              <div className="settings-actions">
                <span className="settings-hint">{ratesLabel()}</span>
                <button className="ghost-button" onClick={onRefreshRates} type="button">
                  {t('refreshRates')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SettingsPanel;
