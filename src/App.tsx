import React, { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { Timestamp, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import './App.v2.css';
import { auth, db } from './firebase';
import { authedJsonHeaders } from './lib/authHeaders';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';
import { useAuthBootstrap } from './hooks/useAuthBootstrap';

import { AuthScreen } from './components/workspaces/AuthScreen';
import type { DayTask } from './lib/dayTask';
import type { HabitDoc } from './components/HabitsList';
import LazySettings from './components/LazySettings';
import { isSubscriptionActive, isInTrial } from './subscription';
import { LimitBanner } from './components/Paywall';
import type { InsightAction } from './components/InsightsFeed';
import { AuthStatusScreen } from './components/shell/AuthStatusScreen';
import { AppHeader } from './components/shell/AppHeader';
import { BottomNav } from './components/shell/BottomNav';
import { DayTab } from './components/tabs/DayTab';
import { LazyCalendarTab, LazyNotesTab, LazyFinanceTab, LazyHabitsTab, preloadTabs } from './components/tabs/LazyTabs';
import type { HabitsSection } from './components/tabs/HabitsTab';
import './components/Subscription.css';
import './components/Notes.css';
import './components/Finance.css';
import './components/Habits.css';
import './components/Day.css';
import './components/Calendar.css';
import './components/AppShell.css';
import './components/Insights.css';
import type { Currency, PrimaryTab, Reminder } from './types/app';
import { usePreferences } from './hooks/usePreferences';
import { useExchangeRates } from './hooks/useExchangeRates';
import { useSubscription } from './hooks/useSubscription';
import { useUserDocSync } from './hooks/useUserDocSync';
import { useUserLocalData } from './hooks/useUserLocalData';
import { useTelegramDisplayName, useTelegramUserMapping } from './hooks/useTelegramProfileSync';
import { useLegacyNotesMigration } from './hooks/useLegacyNotesMigration';
import { useCollectionListener } from './hooks/useCollectionListener';
import { reduceTransactions, reduceByCreatedAtDesc, reduceReminders } from './lib/snapshotReducers';
import { translate } from './i18n/appStrings';
import type { TranslationKey } from './i18n/appStrings';
import { BASE_CURRENCY } from './constants';
import { deriveUserLabels } from './lib/userLabels';
import { perfMark } from './lib/perfMarks';
import {
  buildTelegramReminderText, getReminderScheduledDate,
} from './lib/reminderMessages';

// The app chunk has been fetched and evaluated (DEV/local timing only).
perfMark('app-chunk-loaded');

// How long after the shell appears the other tabs' code is loaded, so that it
// does not compete with the first Firestore snapshots (see preloadTabs).
const TAB_PRELOAD_DELAY_MS = 1000;

// Narrower than types/app's Transaction (which also allows goal_deposit /
// goal_withdraw): the App state and the summaries built from it deal with plain
// income/expense records, so this local shape is kept deliberately.
type Transaction = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  description: string;
  date: string;
  category?: string;
  originalAmount?: number;
  originalCurrency?: Currency;
  source?: string;
  currency?: Currency;
  schemaVersion?: number;
  rubAmount?: number;
  fx?: { rateToRub: number; source: string; [k: string]: unknown } | null;
};

// The app shell: decides the session (useAuthBootstrap), then renders the
// header, the active tab and the bottom navigation. Each tab component owns
// its own list/editor state (it resets when the tab is left); the shell keeps
// only what several tabs share.
const App: React.FC = () => {
  const telegram = useTelegramWebApp();

  const { theme, language, currency, setCurrency, toggleTheme, updateLanguage } = usePreferences(telegram);
  const { rates, ratesUpdatedAt, ratesStatus, loadExchangeRates } = useExchangeRates();
  const [activeTab, setActiveTab] = useState<PrimaryTab>('day-flow');
  // Not reset by tab switches: the Habits/Goals choice is kept while away.
  const [habitsSection, setHabitsSection] = useState<HabitsSection>('habits');
  const [firestoreHabits, setFirestoreHabits] = useState<HabitDoc[]>([]);
  const [dayTasks, setDayTasks] = useState<DayTask[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [trialActivating, setTrialActivating] = useState(false);

  const {
    user, authLoading, authStatus, telegramAuthErrorReason, retryTelegramAuth, chooseOtherSignInMethod,
  } = useAuthBootstrap(telegram, () => setShowOnboarding(true));

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const {
    notes, categories, transactions, setTransactions, profile, setProfile,
  } = useUserLocalData<Transaction>(user, language, reminders, setReminders);
  const [subscription, setSubscription, subscriptionLoaded] = useSubscription(user);
  const [banks, setBanks] = useState<string[]>([]);

  // True when a trial existed, has now expired, and the user hasn't paid
  const trialJustExpired = subscription !== null
    && !!subscription.trialPlan
    && !isInTrial(subscription)
    && !isSubscriptionActive(subscription);

  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  // The first frame of the app is on screen (startup timing, DEV only).
  useEffect(() => { perfMark('first-render'); }, []);

  // A different (or no) account always starts on the Day tab.
  useEffect(() => {
    setActiveTab('day-flow');
  }, [user?.uid]);

  useTelegramDisplayName(user, telegram, profile, setProfile);

  useUserDocSync(user, telegram, setCurrency, setBanks);

  const persistReminderToFirestore = useCallback(
    async (reminder: Reminder, options?: { isNew?: boolean; status?: 'pending' | 'done' }) => {
      if (!user) return;

      const chatId = telegram?.initDataUnsafe?.user?.id ?? null;
      const scheduledAt = getReminderScheduledDate(reminder);
      const status = options?.status ?? (reminder.done ? 'done' : 'pending');
      const payload = {
        id: reminder.id,
        userId: user.uid,
        chatId,
        title: reminder.title,
        notes: reminder.notes ?? null,
        date: reminder.date,
        time: reminder.time,
        scheduledAt: Timestamp.fromDate(new Date(scheduledAt.getTime() - 30_000)),
        status,
        done: reminder.done,
        language,
        telegramText: buildTelegramReminderText(reminder, language),
        updatedAt: serverTimestamp(),
        ...(options?.isNew ? { createdAt: serverTimestamp() } : {})
      };

      try {
        await setDoc(doc(db, 'reminders', reminder.id), payload, { merge: true });
      } catch (error) {
        console.warn('Failed to sync reminder', error);
      }
    },
    [language, telegram, user]
  );

  const remindersBackfillRef = useRef(false);

  // Firestore listeners (transactions, habits, day tasks, reminders) — see
  // hooks/useCollectionListener.ts for the shared lifecycle and
  // lib/snapshotReducers.ts for how each snapshot is folded into state.
  useCollectionListener(user?.uid, 'transactions', setTransactions, reduceTransactions, {
    snapshotError: 'Transaction onSnapshot error', subscribeError: 'Failed to subscribe to transactions',
  });
  useCollectionListener(user?.uid, 'habits', setFirestoreHabits, reduceByCreatedAtDesc, {
    snapshotError: 'Habits onSnapshot error', subscribeError: 'Failed to subscribe to habits',
  });
  useCollectionListener(user?.uid, 'tasks', setDayTasks, reduceByCreatedAtDesc, {
    snapshotError: 'DayTasks onSnapshot error', subscribeError: 'Failed to subscribe to day tasks',
  });
  useCollectionListener(user?.uid, 'reminders', setReminders, reduceReminders, {
    snapshotError: 'Reminders onSnapshot error', subscribeError: 'Failed to subscribe to reminders',
  });

  // NOTE: there is deliberately no client-side backfill of transactions to
  // Firestore any more. Money fields (rubAmount/fx) are server-owned, and a
  // stale localStorage cache must never resurrect deleted transactions.

  useLegacyNotesMigration(user, notes);

  useEffect(() => {
    if (!user) return;
    if (remindersBackfillRef.current) return;
    if (reminders.length === 0) {
      remindersBackfillRef.current = true;
      return;
    }
    remindersBackfillRef.current = true;
    reminders.forEach(reminder => {
      persistReminderToFirestore(reminder, {
        isNew: true,
        status: reminder.done ? 'done' : 'pending'
      });
    });
  }, [reminders, persistReminderToFirestore, user]);

  useTelegramUserMapping(user, telegram);

  const updateCurrency = (next: Currency) => {
    if (next === currency) return;
    setCurrency(next);
    if (user?.uid) {
      setDoc(doc(db, 'users', user.uid), { currency: next, updatedAt: serverTimestamp() }, { merge: true })
        .catch(err => console.warn('Failed to sync currency to Firestore', err));
    }
  };


  const saveBanks = useCallback((newBanks: string[]) => {
    setBanks(newBanks);
    if (user?.uid) {
      setDoc(doc(db, 'users', user.uid), { banks: newBanks, updatedAt: serverTimestamp() }, { merge: true })
        .catch(err => console.warn('Failed to sync banks', err));
    }
  }, [user]);

  // Habit reminders are materialized server-side (functions/src/index.ts's
  // materializeHabitReminders, every 15 min) directly from the Firestore
  // `habits` collection, so delivery no longer depends on this screen being
  // open. A client-side scheduler used to live here, but it only ever acted
  // on the legacy localStorage-only `habits` state above (type Habit, with
  // `history`/no `repeatType`/`repeatDays`) — never on `firestoreHabits`,
  // the actual data the Habits tab reads and writes. Since nothing
  // populates that legacy state for the current Habits feature, it never
  // ran for a real habit; removed rather than "fixed" so there's exactly
  // one place (the server) that decides when a habit reminder is due.

  const handleStartTrial = useCallback(async () => {
    if (!user || trialActivating) return;
    setTrialActivating(true);
    try {
      const res = await fetch('/api/payment/trial', {
        method: 'POST', headers: await authedJsonHeaders(user),
        body: JSON.stringify({ userId: user.uid }),
      });
      if (res.ok) setShowOnboarding(false);
    } catch { /* ignore */ } finally {
      setTrialActivating(false);
    }
  }, [user, trialActivating]);


  const deciding = authLoading || authStatus === 'checking' || authStatus === 'telegram_auth' || authStatus === 'telegram_auth_error';
  const shellVisible = !deciding && !!user;
  useEffect(() => {
    if (!shellVisible) return;
    perfMark('shell-rendered');
    const timer = window.setTimeout(() => {
      void preloadTabs().then(() => perfMark('tabs-preloaded'));
    }, TAB_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [shellVisible]);

  const labels = deriveUserLabels({
    profileDisplayName: profile?.displayName,
    telegramUser: telegram?.initDataUnsafe?.user,
    email: user?.email,
    fallbackName: t('greetingFallback'),
  });

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  };

  const handleTabSwitch = (tabId: PrimaryTab) => setActiveTab(tabId);

  // Route an insight's call to action to the tab of its domain.
  const handleInsightCta = (action: InsightAction) => {
    const target = action.target || '';
    if (target.startsWith('finance.')) handleTabSwitch('finance');
    else if (target.startsWith('tasks.'))   handleTabSwitch('calendar');
    else if (target.startsWith('habits.'))  handleTabSwitch('habits');
  };

  const authScreen = (
    <AuthStatusScreen
      theme={theme}
      authLoading={authLoading}
      authStatus={authStatus}
      telegramAuthErrorReason={telegramAuthErrorReason}
      onRetryTelegram={retryTelegramAuth}
      onOtherSignInMethod={chooseOtherSignInMethod}
      t={t}
    />
  );
  if (deciding) {
    return authScreen;
  }

  if (!user) {
    return (
      <AuthScreen
        theme={theme}
        onToggleTheme={toggleTheme}
        initialName={labels.telegramName}
        language={language}
      />
    );
  }

  return (
    <div className={`app-shell theme-${theme}`}>

      <AppHeader
        language={language}
        theme={theme}
        subscription={subscription}
        avatarInitials={labels.avatarInitials}
        headerNick={labels.headerNick}
        identityLine={labels.identityLine}
        settingsActive={activeTab === 'settings'}
        onOpenSettings={() => handleTabSwitch('settings')}
        onToggleTheme={toggleTheme}
        onSignOut={handleSignOut}
        t={t}
      />

      <main className="app-main">
        {trialJustExpired && (
          <LimitBanner
            message={language === 'ru'
              ? 'Пробный период закончился. Обновите до Pro, чтобы добавлять новые элементы.'
              : 'Your trial ended. Upgrade to Pro to keep adding items.'}
            onUpgrade={() => handleTabSwitch('settings')}
            upgradeLabel={language === 'ru' ? 'Обновить' : 'Upgrade'}
          />
        )}
        {activeTab === 'day-flow' && (
          <DayTab
            language={language}
            user={user}
            currency={BASE_CURRENCY}
            rates={rates}
            firestoreHabits={firestoreHabits}
            transactions={transactions}
            tasks={dayTasks}
            subscription={subscription}
            subscriptionLoaded={subscriptionLoaded}
            showOnboarding={showOnboarding}
            trialActivating={trialActivating}
            onStartTrial={handleStartTrial}
            onDismissOnboarding={() => setShowOnboarding(false)}
            onInsightCta={handleInsightCta}
          />
        )}
        {activeTab === 'calendar' && (
          <LazyCalendarTab language={language} user={user} tasks={dayTasks} subscription={subscription} />
        )}
        {activeTab === 'notes' && (
          <LazyNotesTab language={language} user={user} subscription={subscription} />
        )}
        {activeTab === 'finance' && (
          <LazyFinanceTab
            language={language}
            user={user}
            currency={BASE_CURRENCY}
            inputCurrency={currency}
            rates={rates}
            categories={categories}
            transactions={transactions}
            banks={banks}
            subscription={subscription}
            subscriptionLoaded={subscriptionLoaded}
          />
        )}
        {activeTab === 'habits' && (
          <LazyHabitsTab
            language={language}
            user={user}
            habits={firestoreHabits}
            subscription={subscription}
            section={habitsSection}
            onSectionChange={setHabitsSection}
          />
        )}
        {activeTab === 'settings' && (
          <LazySettings
            language={language}
            theme={theme}
            currency={currency}
            user={user}
            subscription={subscription}
            subscriptionLoaded={subscriptionLoaded}
            ratesStatus={ratesStatus}
            ratesUpdatedAt={ratesUpdatedAt}
            onLanguageChange={updateLanguage}
            onCurrencyChange={(c) => updateCurrency(c as Currency)}
            onThemeToggle={toggleTheme}
            onRefreshRates={() => loadExchangeRates(true)}
            onSubscriptionChange={setSubscription}
            onSignOut={handleSignOut}
            banks={banks}
            onBanksChange={saveBanks}
          />
        )}
      </main>

      <BottomNav language={language} activeTab={activeTab} onSelect={handleTabSwitch} />

    </div>
  );
};

export default App;
