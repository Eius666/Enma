import React, { useEffect, useState } from 'react';
import './styles/auth.css';
import { FaMoon, FaSun } from 'react-icons/fa';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '../../firebase';
import { createT } from '../../i18n/createT';
import type { Language, Theme } from './types';

const AGREED_KEY = 'enma.agreedToTerms';

const saveProfile = (uid: string, data: { displayName: string }) => {
  localStorage.setItem(`enma.${uid}.profile`, JSON.stringify(data));
};

const openLink = (url: string) => {
  const tgWebApp = (window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }).Telegram?.WebApp;
  if (tgWebApp?.openLink) {
    tgWebApp.openLink(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

type AuthScreenProps = {
  theme: Theme;
  onToggleTheme: () => void;
  initialName?: string | null;
  language: Language;
};

export const AuthScreen: React.FC<AuthScreenProps> = ({
  theme,
  onToggleTheme,
  initialName,
  language,
}) => {
  const t = createT(language);
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(initialName ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState<boolean>(
    () => localStorage.getItem(AGREED_KEY) === 'true'
  );

  useEffect(() => {
    if (initialName && !displayName) {
      setDisplayName(initialName);
    }
  }, [initialName, displayName]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (mode === 'sign-up' && !displayName.trim()) {
        throw new Error(t('auth.errorNameRequired'));
      }
      if (mode === 'sign-in') {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        saveProfile(credential.user.uid, { displayName: displayName.trim() });
      }
      setEmail('');
      setPassword('');
      setDisplayName('');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth.errorDefault');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleMode = () => {
    setMode(prev => (prev === 'sign-in' ? 'sign-up' : 'sign-in'));
    setError('');
    setDisplayName(initialName ?? '');
  };

  return (
    <div className={`auth-screen theme-${theme}`}>
      <div className="auth-card">
        <header className="auth-header">
          <span className="badge badge-live">{t('auth.badge')}</span>
          <h1>{t('auth.title')}</h1>
          <p>{t('auth.subtitle')}</p>
          <a
            href="https://t.me/YourArc_bot"
            target="_blank"
            rel="noopener noreferrer"
            className="auth-bot-link"
          >
            💬 {language === 'ru' ? 'Открыть бота в Telegram' : 'Open bot in Telegram'}
          </a>
        </header>

        <button
          className="theme-toggle auth-toggle"
          onClick={onToggleTheme}
          aria-label={t('hero.toggleThemeAria')}
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'sign-up' && (
            <label className="floating-label">
              <span>{t('auth.nameLabel')}</span>
              <input
                type="text"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                placeholder={t('auth.namePlaceholder')}
                required
                autoComplete="name"
              />
            </label>
          )}
          <label className="floating-label">
            <span>{t('auth.emailLabel')}</span>
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              required
              autoComplete="email"
            />
          </label>
          <label className="floating-label">
            <span>{t('auth.passwordLabel')}</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              required
              minLength={6}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={submitting || !agreedToTerms}>
            {submitting
              ? t('auth.submitLoading')
              : mode === 'sign-in'
              ? t('auth.submitSignIn')
              : t('auth.submitSignUp')}
          </button>

          {!agreedToTerms && (
            <div className="auth-consent">
              <label className="auth-consent__check">
                <input
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={e => {
                    const checked = e.target.checked;
                    setAgreedToTerms(checked);
                    if (checked) {
                      localStorage.setItem(AGREED_KEY, 'true');
                    } else {
                      localStorage.removeItem(AGREED_KEY);
                    }
                  }}
                />
                <span>
                  {t('auth.consentAgree')}
                  <button type="button" className="auth-consent__link" onClick={() => openLink('/privacy.html')}>
                    {t('auth.consentPrivacy')}
                  </button>
                  {t('auth.consentAnd')}
                  <button type="button" className="auth-consent__link" onClick={() => openLink('/terms.html')}>
                    {t('auth.consentTerms')}
                  </button>
                </span>
              </label>
              <p className="auth-consent__note">{t('auth.consentNote')}</p>
            </div>
          )}
        </form>

        <p className="auth-switch">
          {mode === 'sign-in' ? t('auth.switchPromptSignIn') : t('auth.switchPromptSignUp')}{' '}
          <button type="button" onClick={toggleMode}>
            {mode === 'sign-in' ? t('auth.switchCreate') : t('auth.switchSignIn')}
          </button>
        </p>
      </div>
    </div>
  );
};
