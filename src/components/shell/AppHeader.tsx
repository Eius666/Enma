import React from 'react';
import { FaMoon, FaSun, FaCog, FaSignOutAlt } from 'react-icons/fa';
import { isSubscriptionActive, isInTrial, getActivePlan, trialDaysRemaining } from '../../subscription';
import type { Subscription } from '../../subscription';
import type { TranslationKey } from '../../i18n/appStrings';

interface Props {
  language: string;
  theme: string;
  subscription: Subscription | null;
  avatarInitials: string;
  headerNick: string;
  identityLine: string;
  settingsActive: boolean;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  t: (key: TranslationKey) => string;
}

// Compact header bar: avatar with the plan badge, greeting, identity line and
// the settings / theme / sign-out buttons.
export function AppHeader({
  language, theme, subscription, avatarInitials, headerNick, identityLine,
  settingsActive, onOpenSettings, onToggleTheme, onSignOut, t,
}: Props): React.ReactElement {
  const hasPlan = !!subscription && (isSubscriptionActive(subscription) || isInTrial(subscription));
  const trialOnly = !!subscription && isInTrial(subscription) && !isSubscriptionActive(subscription);
  return (
    <header className="header-bar">
      <div className="header-left">
        {/* Avatar + optional PRO label below (Instagram-story style) */}
        <div className="header-avatar-wrap" aria-hidden="true">
          <div className={`header-avatar${hasPlan ? ' header-avatar--pro' : ''}`}>
            {avatarInitials}
          </div>
          {hasPlan && (
            <span className={`header-avatar-pro-label${trialOnly ? ' header-avatar-pro-label--trial' : ''}`}>
              {trialOnly
                ? (language === 'ru'
                  ? `TRIAL ${trialDaysRemaining(subscription!)}д`
                  : `TRIAL ${trialDaysRemaining(subscription!)}d`)
                : getActivePlan(subscription).toUpperCase()
              }
            </span>
          )}
        </div>
        <div className="header-greeting-block">
          <span className="header-greeting-sub">
            {language === 'ru' ? 'Привет,' : 'Hi,'}
          </span>
          <span className={`header-greeting-name${headerNick.length > 15 ? ' header-greeting-name--long' : ''}`}>
            {headerNick}
          </span>
        </div>
      </div>
      <div className="header-right">
        {/* Email — small text, no box */}
        <span className="header-email">{identityLine}</span>
        {/* Settings gear — SVG, no emoji */}
        <button
          className={`header-icon-btn${settingsActive ? ' header-icon-btn--active' : ''}`}
          onClick={onOpenSettings}
          aria-label="Settings"
          type="button"
        >
          <FaCog />
        </button>
        {/* Theme toggle — SVG sun/moon, no emoji */}
        <button
          className="header-icon-btn"
          onClick={onToggleTheme}
          aria-label={t('toggleThemeAria')}
          type="button"
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>
        {/* Sign out — SVG icon only, no text */}
        <button
          className="header-icon-btn header-icon-btn--danger"
          onClick={onSignOut}
          aria-label={t('signOut')}
          type="button"
        >
          <FaSignOutAlt />
        </button>
      </div>
    </header>
  );
}
