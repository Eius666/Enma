import React, { useEffect, useState } from 'react';
import { FaMoon, FaSun } from 'react-icons/fa';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { saveProfile } from '../lib/utils';
import { translate } from '../i18n/translations';
import type { TranslationKey } from '../i18n/translations';
import type { Language, Theme } from '../types';

type AuthScreenProps = {
  theme: Theme;
  onToggleTheme: () => void;
  initialName?: string | null;
  language: Language;
};

const AuthScreen: React.FC<AuthScreenProps> = ({ theme, onToggleTheme, initialName, language }) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(initialName ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (initialName && !displayName) setDisplayName(initialName);
  }, [initialName, displayName]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (mode === 'sign-up' && !displayName.trim()) {
        throw new Error(t('authErrorNameRequired'));
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
      setError(err instanceof Error ? err.message : t('authErrorDefault'));
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
          <span className="badge badge-live">{t('authBadge')}</span>
          <h1>{t('authTitle')}</h1>
          <p>{t('authSubtitle')}</p>
        </header>

        <button className="theme-toggle auth-toggle" onClick={onToggleTheme} aria-label={t('toggleThemeAria')}>
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'sign-up' && (
            <label className="floating-label">
              <span>{t('authNameLabel')}</span>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('authNamePlaceholder')}
                required
                autoComplete="name"
              />
            </label>
          )}
          <label className="floating-label">
            <span>{t('authEmailLabel')}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('authEmailPlaceholder')}
              required
              autoComplete="email"
            />
          </label>
          <label className="floating-label">
            <span>{t('authPasswordLabel')}</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('authPasswordPlaceholder')}
              required
              minLength={6}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? t('authSubmitLoading')
              : mode === 'sign-in'
              ? t('authSubmitSignIn')
              : t('authSubmitSignUp')}
          </button>
        </form>

        <p className="auth-switch">
          {mode === 'sign-in' ? t('authSwitchPromptSignIn') : t('authSwitchPromptSignUp')}{' '}
          <button type="button" onClick={toggleMode}>
            {mode === 'sign-in' ? t('authSwitchCreate') : t('authSwitchSignIn')}
          </button>
        </p>
      </div>
    </div>
  );
};

export default AuthScreen;
