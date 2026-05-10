import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { compareAsc, parseISO } from 'date-fns';
import { FaMoon, FaSun } from 'react-icons/fa';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { signOut } from 'firebase/auth';
import './App.v2.css';
import { auth, db } from './lib/firebase';
import { translate } from './i18n/translations';
import type { TranslationKey } from './i18n/translations';
import { formatDate } from './lib/utils';
import { useSettings } from './hooks/useSettings';
import { useAuth } from './hooks/useAuth';
import { useExchangeRates } from './hooks/useExchangeRates';
import { useUserData } from './hooks/useUserData';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';
import AuthScreen from './components/AuthScreen';
import DayFlowOverview from './components/DayFlowOverview';
import CalendarWorkspace from './components/CalendarWorkspace';
import NotesWorkspace from './components/NotesWorkspace';
import HabitsWorkspace from './components/HabitsWorkspace';
import FinanceWorkspace from './components/FinanceWorkspace';
import SettingsPanel from './components/SettingsPanel';
import ErrorBoundary from './components/ErrorBoundary';
import type { PrimaryTab } from './types';

const App: React.FC = () => {
  const telegram = useTelegramWebApp();
  const { theme, language, currency, toggleTheme, updateLanguage, updateCurrency } = useSettings(telegram);
  const { user, authLoading } = useAuth(telegram);
  const { rates, ratesUpdatedAt, ratesStatus, loadExchangeRates } = useExchangeRates();
  const {
    tasks, notes, noteProjects, categories, transactions, habits, reminders, profile,
    setTasks, setNotes, setNoteProjects, setCategories, setTransactions,
    addHabit, toggleHabitDay, deleteHabit,
    addReminder, toggleReminder, deleteReminder,
    persistTransactionToFirestore,
    deleteTransactionFromFirestore
  } = useUserData(user, telegram, language);

  const [activeTab, setActiveTab] = useState<PrimaryTab>('day-flow');
  const [notification, setNotification] = useState<string | null>(null);

  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  const notify = useCallback((message: string) => {
    setNotification(message);
    window.setTimeout(() => {
      setNotification(current => (current === message ? null : current));
    }, 3000);
  }, []);

  // Reset active tab on user change
  useEffect(() => {
    if (user) setActiveTab('day-flow');
  }, [user]);

  // Sync currency + chatId to Firestore
  useEffect(() => {
    if (!user) return;
    setDoc(doc(db, 'users', user.uid), { currency, updatedAt: serverTimestamp() }, { merge: true })
      .catch(err => console.warn('Failed to sync currency preference', err));
  }, [user, currency]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    setDoc(
      doc(db, 'users', user.uid),
      { chatId, currency, updatedAt: serverTimestamp() },
      { merge: true }
    ).catch(err => console.warn('Failed to sync user mapping', err));
  }, [user, telegram, currency]);

  // Sync Telegram user profile to Firestore
  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user) return;
    const tgUser = telegram.initDataUnsafe.user;
    setDoc(
      doc(db, 'telegramUsers', `tg_${tgUser.id}`),
      {
        chatId: tgUser.id,
        username: tgUser.username ?? null,
        firstName: tgUser.first_name ?? null,
        lastName: tgUser.last_name ?? null,
        languageCode: tgUser.language_code ?? null,
        firebaseUid: user.uid,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    ).catch(err => console.warn('Failed to sync Telegram user', err));
  }, [user, telegram]);

  // Load exchange rates on mount
  useEffect(() => { loadExchangeRates(); }, [loadExchangeRates]);

  const convertAmount = (amount: number) => amount * (rates[currency] ?? 1);
  const convertToBase = (amount: number) => amount / (rates[currency] ?? 1);

  const upcomingTasks = useMemo(() => {
    const today = new Date();
    return [...tasks]
      .filter(task => compareAsc(parseISO(task.date), today) >= 0)
      .sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date)))
      .slice(0, 3);
  }, [tasks]);

  const latestNote = useMemo(
    () => [...notes].sort((a, b) => compareAsc(parseISO(b.updatedAt), parseISO(a.updatedAt)))[0],
    [notes]
  );

  const financeSummary = useMemo(() => {
    const income = transactions.filter(tx => tx.type === 'income').reduce((s, tx) => s + tx.amount, 0);
    const expenses = transactions.filter(tx => tx.type === 'expense').reduce((s, tx) => s + tx.amount, 0);
    return { income, expenses, balance: income - expenses };
  }, [transactions]);

  const upcomingReminders = useMemo(
    () =>
      [...reminders]
        .filter(r => !r.done && compareAsc(new Date(r.date), new Date()) >= 0)
        .sort((a, b) => compareAsc(new Date(a.date + 'T' + a.time), new Date(b.date + 'T' + b.time)))
        .slice(0, 4),
    [reminders]
  );

  const handleSignOut = async () => {
    try { await signOut(auth); } catch (err) { console.error('Failed to sign out', err); }
  };

  const telegramName =
    telegram?.initDataUnsafe?.user &&
    ([telegram.initDataUnsafe.user.first_name, telegram.initDataUnsafe.user.last_name]
      .filter(Boolean)
      .join(' ') || telegram.initDataUnsafe.user.username);

  const userDisplayName =
    profile?.displayName || telegramName || user?.email?.split('@')[0] || t('greetingFallback');
  const userEmail = user?.email || telegram?.initDataUnsafe?.user?.username || '—';

  const eb = (children: React.ReactNode) => (
    <ErrorBoundary fallbackMessage={t('errorBoundaryMessage')} reloadLabel={t('errorBoundaryReload')}>
      {children}
    </ErrorBoundary>
  );

  if (authLoading) {
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <span className="auth-loading">{t('authLoading')}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen theme={theme} onToggleTheme={toggleTheme} initialName={telegramName} language={language} />
    );
  }

  const referenceDate = new Date();

  return (
    <div className={`app-shell theme-${theme}`}>
      <header className="hero-card">
        <div className="hero-intro">
          <span className="app-mark">Enma</span>
          <h1>{t('greeting', { name: userDisplayName })}</h1>
          <p>{t('heroSubtitle')}</p>
          <a
            className="refresh-link"
            href="https://eius666.github.io/Enma/"
            target="_blank"
            rel="noreferrer"
          >
            {t('productionRefreshed', { date: formatDate(language, referenceDate, 'MMM dd, yyyy p') })}
          </a>
          <span className="hero-email">{userEmail}</span>
        </div>
        <div className="hero-actions">
          <div className="hero-actions-left">
            <button className="sign-out-button" onClick={handleSignOut}>{t('signOut')}</button>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} aria-label={t('toggleThemeAria')}>
            {theme === 'dark' ? <FaSun /> : <FaMoon />}
          </button>
        </div>
      </header>

      <nav className="top-tabs" aria-label="Primary navigation">
        {(
          [
            { id: 'day-flow', label: t('tabDayFlow') },
            { id: 'calendar', label: t('tabCalendar') },
            { id: 'notes', label: t('tabNotes') },
            { id: 'finance', label: t('tabFinance') },
            { id: 'habits', label: t('tabHabits') },
            { id: 'settings', label: t('tabSettings') }
          ] as const
        ).map(tab => (
          <button
            key={tab.id}
            className={`top-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {activeTab === 'day-flow' && eb(
          <DayFlowOverview
            language={language}
            currency={currency}
            convertAmount={convertAmount}
            upcomingTasks={upcomingTasks}
            financeSummary={financeSummary}
            latestNote={latestNote}
            reminders={upcomingReminders}
            onToggleReminder={toggleReminder}
            habits={habits}
            onToggleHabitDay={toggleHabitDay}
          />
        )}
        {activeTab === 'calendar' && eb(
          <CalendarWorkspace
            language={language}
            tasks={tasks}
            reminders={reminders}
            onTasksChange={setTasks}
            onAddReminder={addReminder}
            onToggleReminder={toggleReminder}
            onDeleteReminder={deleteReminder}
          />
        )}
        {activeTab === 'notes' && eb(
          <NotesWorkspace
            language={language}
            notes={notes}
            noteProjects={noteProjects}
            onNotesChange={setNotes}
            onNoteProjectsChange={setNoteProjects}
          />
        )}
        {activeTab === 'finance' && eb(
          <FinanceWorkspace
            language={language}
            currency={currency}
            convertAmount={convertAmount}
            convertToBase={convertToBase}
            categories={categories}
            onCategoriesChange={setCategories}
            transactions={transactions}
            onTransactionsChange={setTransactions}
            onPersistTransaction={persistTransactionToFirestore}
            onDeleteTransaction={deleteTransactionFromFirestore}
            notify={notify}
          />
        )}
        {activeTab === 'habits' && eb(
          <HabitsWorkspace
            language={language}
            habits={habits}
            onAddHabit={addHabit}
            onToggleHabitDay={toggleHabitDay}
            onDeleteHabit={deleteHabit}
          />
        )}
        {activeTab === 'settings' && eb(
          <SettingsPanel
            language={language}
            onLanguageChange={updateLanguage}
            currency={currency}
            onCurrencyChange={updateCurrency}
            ratesUpdatedAt={ratesUpdatedAt}
            ratesStatus={ratesStatus}
            onRefreshRates={() => loadExchangeRates(true)}
          />
        )}
      </main>

      {notification && <div className="app-toast">{notification}</div>}
    </div>
  );
};

export default App;
