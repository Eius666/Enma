import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaMoon,
  FaSun,
  FaCog,
  FaSignOutAlt,
  FaCalendarAlt,
  FaStickyNote,
  FaChartLine,
  FaCheckCircle,
} from 'react-icons/fa';
import {
  User,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut
} from 'firebase/auth';
import { Timestamp, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import './App.v2.css';
import { auth, db } from './firebase';
import { authedJsonHeaders } from './lib/authHeaders';
import { safeGetItem, safeSetItem } from './lib/safeStorage';
import { fetchWithTimeout } from './lib/fetchWithTimeout';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';
import { decideBootstrap, AuthStatus } from './lib/authBootstrap';

import { AuthScreen } from './components/workspaces/AuthScreen';
import DayList from './components/DayList';
import type { DayTask } from './lib/dayTask';
import DayTaskEditor from './components/DayTaskEditor';
import CalendarView from './components/CalendarView';
import FinanceList from './components/FinanceList';
import GoalsList from './components/GoalsList';
import FinanceEditor from './components/FinanceEditor';
import HabitsList, { HabitDoc } from './components/HabitsList';
import HabitEditor from './components/HabitEditor';
import { ToastProvider } from './components/ui/Toast';
import LazySettings from './components/LazySettings';
import NotesList from './components/NotesList';
import NoteEditor from './components/NoteEditor';
import { isSubscriptionActive, isInTrial, getActivePlan, trialDaysRemaining } from './subscription';
import { LimitBanner } from './components/Paywall';
import OnboardingDemo from './components/OnboardingDemo';
import InsightsFeed from './components/InsightsFeed';
import type { InsightAction } from './components/InsightsFeed';
import './components/Subscription.css';
import './components/Notes.css';
import './components/Finance.css';
import './components/Habits.css';
import './components/Day.css';
import './components/Calendar.css';
import './components/AppShell.css';
import './components/Insights.css';
import type {
  Currency, PrimaryTab, CalendarTask, NotePage, NoteProject,
  Category, Habit, AppUserProfile as UserProfile, Reminder,
} from './types/app';
import { usePreferences } from './hooks/usePreferences';
import { useExchangeRates } from './hooks/useExchangeRates';
import { useSubscription } from './hooks/useSubscription';
import { useUserDocSync } from './hooks/useUserDocSync';
import { usePersistedCache } from './hooks/usePersistedCache';
import { useCollectionListener } from './hooks/useCollectionListener';
import { reduceTransactions, reduceByCreatedAtDesc, reduceReminders } from './lib/snapshotReducers';
import { translate } from './i18n/appStrings';
import type { TranslationKey } from './i18n/appStrings';
import {
  STORAGE_KEYS, BASE_CURRENCY, ENABLE_CLIENT_REMINDERS,
} from './constants';
import { saveProfile } from './lib/profileStore';
import { readUserLocalCache } from './lib/userCache';
import {
  buildTelegramReminderText, getReminderScheduledDate, notifyTelegramReminder,
} from './lib/reminderMessages';

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

const App: React.FC = () => {
  const telegram = useTelegramWebApp();

  const { theme, language, currency, setCurrency, toggleTheme, updateLanguage } = usePreferences(telegram);
  const { rates, ratesUpdatedAt, ratesStatus, loadExchangeRates } = useExchangeRates();
  const [activeTab, setActiveTab] = useState<PrimaryTab>('day-flow');
  const [notesView, setNotesView] = useState<'list' | 'editor'>('list');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  // Set only when opening a note recovered from NotesList's "unsaved note"
  // banner — see NoteEditor's recoveredDraftId prop.
  const [recoveredDraftId, setRecoveredDraftId] = useState<string | null>(null);
  const [financeView, setFinanceView] = useState<'list' | 'editor'>('list');
  const [habitsSection, setHabitsSection] = useState<'habits' | 'goals'>('habits');
  const [activeTransactionId, setActiveTransactionId] = useState<string | null>(null);
  const [habitsView, setHabitsView] = useState<'list' | 'editor'>('list');
  const [activeHabitId, setActiveHabitId] = useState<string | null>(null);
  const [firestoreHabits, setFirestoreHabits] = useState<HabitDoc[]>([]);
  const [dayView, setDayView] = useState<'list' | 'editor'>('list');
  const [activeDayTaskId, setActiveDayTaskId] = useState<string | null>(null);
  const [dayTasks, setDayTasks] = useState<DayTask[]>([]);
  const [calView, setCalView] = useState<'calendar' | 'editor'>('calendar');
  const [activeCalTaskId, setActiveCalTaskId] = useState<string | null>(null);
  const [calPreDate, setCalPreDate] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // See src/lib/authBootstrap.ts / TELEGRAM_AUTOLOGIN audit: kept separate
  // from `authLoading`/`user` specifically so the render layer can tell
  // "no session yet, but a Telegram auto-auth attempt is in flight" apart
  // from "no session and nothing else is going to happen" — the former
  // must never show the manual login screen.
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  // Only meaningful while authStatus === 'telegram_auth_error' — which of
  // the 3 distinct backend outcomes caused it, so the retry screen can show
  // honest, specific copy (see TELEGRAM_PASSWORDLESS_AUTOAUTH audit §12)
  // instead of one generic message for a network blip, an identity
  // conflict, and an orphaned historical mapping alike.
  const [telegramAuthErrorReason, setTelegramAuthErrorReason] =
    useState<'generic' | 'identity_conflict' | 'recovery_required'>('generic');
  const prevUserId = useRef<string | null>(null);
  const telegramAuthAttemptedRef = useRef(false);

  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [notes, setNotes] = useState<NotePage[]>([]);
  const [noteProjects, setNoteProjects] = useState<NoteProject[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [subscription, setSubscription] = useSubscription(user);
  const [banks, setBanks] = useState<string[]>([]);

  // True when a trial existed, has now expired, and the user hasn't paid
  const trialJustExpired = subscription !== null
    && !!subscription.trialPlan
    && !isInTrial(subscription)
    && !isSubscriptionActive(subscription);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [trialActivating, setTrialActivating] = useState(false);

  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  useEffect(() => {
    if (!telegram) return;
    const updateViewport = () => {
      const height = telegram.viewportHeight ?? window.innerHeight;
      document.documentElement.style.setProperty('--tg-viewport-height', `${height}px`);
    };
    updateViewport();
    const handleViewport = () => updateViewport();
    telegram.onEvent?.('viewportChanged', handleViewport);
    return () => {
      telegram.offEvent?.('viewportChanged', handleViewport);
    };
  }, [telegram]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, current => {
      setUser(current);
      setAuthLoading(false);
      if (current) setAuthStatus('authenticated');
    });
    return unsubscribe;
  }, []);

  // Telegram auto-auth bootstrap (TELEGRAM_PASSWORDLESS_AUTOAUTH audit).
  // Gates on raw `telegram.initData` ONLY — never `initDataUnsafe` —
  // because that's the one value the backend can actually HMAC-verify;
  // initDataUnsafe is diagnostics-only (see useTelegramWebApp's runtime
  // log) and must never decide whether we attempt or trust an auth flow.
  //
  // Deliberately does NOT fall back to signInAnonymously on failure
  // (removed — audit §1/§7): an anonymous Firebase user is a BRAND NEW,
  // disconnected identity, which is exactly the "duplicate account" outcome
  // this whole effort exists to prevent. If the verified-Telegram attempt
  // fails, the user sees a distinct retry screen (authStatus becomes
  // 'telegram_auth_error') — never a silently-empty new account, never the
  // manual AuthScreen automatically.
  const attemptTelegramAuth = useCallback(async (initData: string) => {
    setAuthStatus('telegram_auth');
    try {
      const res = await fetchWithTimeout('/api/auth/telegram', {
        timeoutMs: 30_000, // identity lookup is idempotent; a stalled request lands on the retry screen
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          await signInWithCustomToken(auth, data.token);
          if (data.isNewUser) setShowOnboarding(true);
          return; // onAuthStateChanged fires next and sets 'authenticated'
        }
      }
      // TELEGRAM_IDENTITY_CONFLICT / TELEGRAM_ACCOUNT_RECOVERY_REQUIRED
      // (see api/auth/telegram.js) get their own copy below — both are
      // deliberate "don't touch this account automatically" outcomes, not
      // generic failures, so they're distinguished here rather than lumped
      // into the same retry screen as a network error.
      let code: string | null = null;
      try { code = (await res.json())?.code ?? null; } catch { /* body already consumed or not JSON */ }
      setTelegramAuthErrorReason(
        code === 'TELEGRAM_IDENTITY_CONFLICT' ? 'identity_conflict' :
        code === 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED' ? 'recovery_required' :
        'generic'
      );
      throw new Error(`backend rejected (status ${res.status})`);
    } catch (err) {
      console.warn('Telegram auto-auth failed', err);
      setAuthStatus('telegram_auth_error');
    }
  }, []);

  // decideBootstrap is a pure function (src/lib/authBootstrap.ts, unit
  // tested) specifically so the "don't show the login screen while Telegram
  // auth is still in flight" rule can't silently regress again — this is
  // the exact race this audit was opened for.
  useEffect(() => {
    if (authLoading) return;

    const decision = decideBootstrap({
      hasExistingSession: !!user,
      telegramInitDataPresent: !!telegram?.initData,
      alreadyAttemptedTelegramAuth: telegramAuthAttemptedRef.current,
    });

    if (decision === 'wait') return;

    if (decision === 'unauthenticated') {
      setAuthStatus('unauthenticated');
      return;
    }

    // decision === 'telegram_auth'
    telegramAuthAttemptedRef.current = true;
    attemptTelegramAuth(telegram!.initData);
  }, [authLoading, user, telegram, attemptTelegramAuth]);

  // "Повторить вход через Telegram" — reuses the CURRENT raw initData
  // (audit §16), never asks for login/password/Telegram id.
  const retryTelegramAuth = useCallback(() => {
    if (telegram?.initData) attemptTelegramAuth(telegram.initData);
  }, [telegram, attemptTelegramAuth]);

  // "Другой способ входа" — explicit opt-in escape hatch to the manual
  // AuthScreen. Only reachable from telegram_auth_error, never automatic.
  const useOtherSignInMethod = useCallback(() => {
    setAuthStatus('unauthenticated');
  }, []);


  useEffect(() => {
    if (!user) {
      setTasks([]);
      setNotes([]);
      setNoteProjects([]);
      setCategories([]);
      setTransactions([]);
      setHabits([]);
      setReminders([]);
      setProfile(null);
      setActiveTab('day-flow');
      prevUserId.current = null;
      return;
    }

    if (prevUserId.current === user.uid) {
      return;
    }
    prevUserId.current = user.uid;

    const cache = readUserLocalCache<Transaction>(user.uid, language);
    setTasks(cache.tasks);
    setNoteProjects(cache.noteProjects);
    setNotes(cache.notes);
    setCategories(cache.categories);
    setTransactions(cache.transactions);
    setHabits(cache.habits);
    setReminders(cache.reminders);
    setProfile(cache.profile);
    setActiveTab('day-flow');
  }, [user, language]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user) return;
    if (profile?.displayName) return;
    const tgUser = telegram.initDataUnsafe.user;
    const tgName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Friend';
    const nextProfile: UserProfile = { displayName: tgName };
    setProfile(nextProfile);
    saveProfile(user.uid, nextProfile);
  }, [telegram, user, profile]);

  usePersistedCache(user?.uid, STORAGE_KEYS.tasks, tasks);
  usePersistedCache(user?.uid, STORAGE_KEYS.notes, notes);
  usePersistedCache(user?.uid, STORAGE_KEYS.noteProjects, noteProjects);
  usePersistedCache(user?.uid, STORAGE_KEYS.categories, categories);
  usePersistedCache(user?.uid, STORAGE_KEYS.transactions, transactions);
  usePersistedCache(user?.uid, STORAGE_KEYS.habits, habits);
  usePersistedCache(user?.uid, STORAGE_KEYS.reminders, reminders);

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
  const notesLsMigrationRef = useRef(false);

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

  useEffect(() => {
    if (!user || notes.length === 0) return;
    const markerKey = `enma.${user.uid}.notesLsMigrated`;
    if (safeGetItem(markerKey) === '1') return;
    if (notesLsMigrationRef.current) return;
    notesLsMigrationRef.current = true;

    const migrate = async () => {
      for (const page of notes) {
        if (!page.title && page.blocks.length === 0) continue;
        try {
          const ref = doc(db, 'notes', page.id);
          const snap = await getDoc(ref);
          if (snap.exists()) continue;
          const content = page.blocks
            .map(b => (b.type === 'todo' ? `- [${b.checked ? 'x' : ' '}] ${b.content}` : b.content))
            .filter(Boolean)
            .join('\n');
          await setDoc(ref, {
            id: page.id,
            userId: user.uid,
            title: page.title || '(без названия)',
            content,
            type: page.noteType === 'checklist' ? 'checklist' : 'text',
            checklistItems: [],
            category: null,
            pinned: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Free limit exceeded or permissions error — skip note
        }
      }
      safeSetItem(markerKey, '1');
    };

    migrate().catch(() => { /* silent */ });
  }, [user, notes]);

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

  useEffect(() => {
    if (!ENABLE_CLIENT_REMINDERS) return;
    if (!telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    const interval = setInterval(() => {
      setReminders(prev => {
        let changed = false;
        const updated = prev.map(reminder => {
          if (reminder.done || reminder.notified) return reminder;
          const scheduled = getReminderScheduledDate(reminder);
          if (scheduled <= new Date()) {
            notifyTelegramReminder(chatId, reminder, language);
            changed = true;
            return { ...reminder, notified: true };
          }
          return reminder;
        });
        return changed ? updated : prev;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [telegram, language]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
    const tgUser = telegram.initDataUnsafe.user;
    const docRef = doc(db, 'telegramUsers', `tg_${tgUser.id}`);
    setDoc(
      docRef,
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
    ).catch(error => {
      console.warn('Failed to sync Telegram user', error);
    });
  }, [user, telegram]);

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


  const telegramName =
    telegram?.initDataUnsafe?.user &&
    ([telegram.initDataUnsafe.user.first_name, telegram.initDataUnsafe.user.last_name]
      .filter(Boolean)
      .join(' ') ||
      telegram.initDataUnsafe.user.username);

  const userDisplayName =
    profile?.displayName || telegramName || user?.email?.split('@')[0] || t('greetingFallback');

  const telegramUsername = telegram?.initDataUnsafe?.user?.username;
  const telegramFirstName = telegram?.initDataUnsafe?.user?.first_name;
  const headerNick = telegramUsername
    ? `@${telegramUsername}`
    : telegramFirstName
    ? telegramFirstName
    : (profile?.displayName || user?.email?.split('@')[0] || '');
  const userEmail =
    user?.email || telegram?.initDataUnsafe?.user?.username || '—';

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  };

  // First 2 letters of display name for the avatar circle
  const avatarInitials = (userDisplayName as string).slice(0, 2).toUpperCase();

  // Centralised tab-switch handler — resets sub-views
  const handleTabSwitch = (tabId: PrimaryTab) => {
    setActiveTab(tabId);
    if (tabId !== 'day-flow')  { setDayView('list');      setActiveDayTaskId(null); }
    if (tabId !== 'calendar')  { setCalView('calendar');  setActiveCalTaskId(null); setCalPreDate(null); }
    if (tabId !== 'notes')     { setNotesView('list');    setActiveNoteId(null); }
    if (tabId !== 'finance')   { setFinanceView('list');  setActiveTransactionId(null); }
    if (tabId !== 'habits')    { setHabitsView('list');   setActiveHabitId(null); }
  };

  // 'checking' (Firebase restoring any persisted session) AND 'telegram_auth'
  // (a Telegram auto-auth attempt is in flight) both keep showing this
  // loading screen — never AuthScreen. This is the exact fix for
  // TELEGRAM_PASSWORDLESS_AUTOAUTH: a fresh Telegram session used to fall
  // through to the manual login screen the instant Firebase reported "no
  // session", even though the Telegram sign-in attempt had not even
  // started yet.
  if (authLoading || authStatus === 'checking' || authStatus === 'telegram_auth') {
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <span className="auth-loading">
            {authStatus === 'telegram_auth' ? t('authLoadingTelegram') : t('authLoading')}
          </span>
        </div>
      </div>
    );
  }

  // Telegram initData was present but the auto-auth attempt itself failed
  // (network error, backend rejection, etc.) — a distinct screen, never a
  // silent fall-through to the manual login form (audit §15/§16).
  //
  // recovery_required gets its own, single-button copy: retrying the exact
  // same initData against a deterministically dead mapping changes nothing,
  // and "Создать новый аккаунт" must never be the primary (or only) action
  // here — audit §12. "Восстановить аккаунт" leads to the manual AuthScreen
  // as the only credential-based path available today; a dedicated
  // ownership-confirmation recovery flow (audit §13) is intentionally out
  // of scope for this round.
  if (authStatus === 'telegram_auth_error') {
    if (telegramAuthErrorReason === 'recovery_required') {
      return (
        <div className={`auth-screen theme-${theme}`}>
          <div className="auth-card loading-card">
            <p className="auth-error">{t('authTelegramRecoveryTitle')}</p>
            <button type="button" className="primary-button auth-submit" onClick={useOtherSignInMethod}>
              {t('authTelegramRecoveryAction')}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <p className="auth-error">
            {telegramAuthErrorReason === 'identity_conflict' ? t('authTelegramConflictTitle') : t('authTelegramErrorTitle')}
          </p>
          <button type="button" className="primary-button auth-submit" onClick={retryTelegramAuth}>
            {t('authTelegramErrorRetry')}
          </button>
          <button type="button" className="ghost-button" onClick={useOtherSignInMethod}>
            {t('authTelegramErrorOther')}
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        theme={theme}
        onToggleTheme={toggleTheme}
        initialName={telegramName}
        language={language}
      />
    );
  }

  return (
    <ToastProvider>
    <div className={`app-shell theme-${theme}`}>

      {/* ── Compact header bar ── */}
      <header className="header-bar">
        <div className="header-left">
          {/* Avatar + optional PRO label below (Instagram-story style) */}
          <div className="header-avatar-wrap" aria-hidden="true">
            <div
              className={`header-avatar${subscription && (isSubscriptionActive(subscription) || isInTrial(subscription)) ? ' header-avatar--pro' : ''}`}
            >
              {avatarInitials}
            </div>
            {subscription && (isSubscriptionActive(subscription) || isInTrial(subscription)) && (
              <span className={`header-avatar-pro-label${isInTrial(subscription) && !isSubscriptionActive(subscription) ? ' header-avatar-pro-label--trial' : ''}`}>
                {isInTrial(subscription) && !isSubscriptionActive(subscription)
                  ? (language === 'ru'
                    ? `TRIAL ${trialDaysRemaining(subscription)}д`
                    : `TRIAL ${trialDaysRemaining(subscription)}d`)
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
          <span className="header-email">{userEmail}</span>
          {/* Settings gear — SVG, no emoji */}
          <button
            className={`header-icon-btn${activeTab === 'settings' ? ' header-icon-btn--active' : ''}`}
            onClick={() => handleTabSwitch('settings')}
            aria-label="Settings"
            type="button"
          >
            <FaCog />
          </button>
          {/* Theme toggle — SVG sun/moon, no emoji */}
          <button
            className="header-icon-btn"
            onClick={toggleTheme}
            aria-label={t('toggleThemeAria')}
            type="button"
          >
            {theme === 'dark' ? <FaSun /> : <FaMoon />}
          </button>
          {/* Sign out — SVG icon only, no text */}
          <button
            className="header-icon-btn header-icon-btn--danger"
            onClick={handleSignOut}
            aria-label={t('signOut')}
            type="button"
          >
            <FaSignOutAlt />
          </button>
        </div>
      </header>

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
        {activeTab === 'day-flow' && dayView === 'list' && showOnboarding && (
          <OnboardingDemo
            language={language}
            onStartTrial={handleStartTrial}
            onDismiss={() => setShowOnboarding(false)}
            trialLoading={trialActivating}
          />
        )}
        {activeTab === 'day-flow' && dayView === 'list' && (
          <InsightsFeed
            user={user}
            language={language}
            maxVisible={3}
            onCta={(action: InsightAction) => {
              // Route CTA to appropriate tab based on skill target domain
              const target = action.target || '';
              if (target.startsWith('finance.')) handleTabSwitch('finance');
              else if (target.startsWith('tasks.'))   handleTabSwitch('calendar');
              else if (target.startsWith('habits.'))  handleTabSwitch('habits');
            }}
          />
        )}
        {activeTab === 'day-flow' && dayView === 'list' && (
          <DayList
            language={language}
            user={user}
            currency={BASE_CURRENCY}
            rates={rates}
            firestoreHabits={firestoreHabits}
            transactions={transactions}
            tasks={dayTasks}
            onOpenEditor={(id) => {
              setActiveDayTaskId(id);
              setDayView('editor');
              window.scrollTo({ top: 0, behavior: 'auto' });
            }}
          />
        )}
        {activeTab === 'day-flow' && dayView === 'editor' && (
          <DayTaskEditor
            taskId={activeDayTaskId}
            initialTask={
              activeDayTaskId
                ? dayTasks.find(t => t.id === activeDayTaskId) ?? null
                : null
            }
            user={user}
            language={language}
            subscription={subscription}
            onBack={() => {
              setDayView('list');
              setActiveDayTaskId(null);
            }}
          />
        )}
        {activeTab === 'calendar' && calView === 'calendar' && (
          <CalendarView
            language={language}
            user={user}
            tasks={dayTasks}
            onOpenEditor={(id, date) => {
              setActiveCalTaskId(id);
              setCalPreDate(date ?? null);
              setCalView('editor');
              window.scrollTo({ top: 0, behavior: 'auto' });
            }}
          />
        )}
        {activeTab === 'calendar' && calView === 'editor' && (
          <DayTaskEditor
            taskId={activeCalTaskId}
            initialTask={
              activeCalTaskId
                ? dayTasks.find(t => t.id === activeCalTaskId) ?? null
                : null
            }
            initialDate={calPreDate ?? undefined}
            user={user}
            language={language}
            subscription={subscription}
            onBack={() => {
              setCalView('calendar');
              setActiveCalTaskId(null);
              setCalPreDate(null);
            }}
          />
        )}
        {activeTab === 'notes' && notesView === 'list' && (
          <NotesList
            user={user}
            language={language}
            onOpenEditor={(id) => {
              setActiveNoteId(id);
              setRecoveredDraftId(null);
              setNotesView('editor');
            }}
            onRecoverDraft={(draftId) => {
              setActiveNoteId(null);
              setRecoveredDraftId(draftId);
              setNotesView('editor');
            }}
          />
        )}
        {activeTab === 'notes' && notesView === 'editor' && (
          <NoteEditor
            noteId={activeNoteId}
            recoveredDraftId={recoveredDraftId}
            user={user}
            language={language}
            subscription={subscription}
            onBack={() => {
              setNotesView('list');
              setActiveNoteId(null);
              setRecoveredDraftId(null);
            }}
          />
        )}
        {activeTab === 'finance' && financeView === 'list' && (
          <FinanceList
            language={language}
            currency={BASE_CURRENCY}
            rates={rates}
            categories={categories}
            transactions={transactions}
            user={user}
            onOpenEditor={(id) => {
              setActiveTransactionId(id);
              setFinanceView('editor');
              window.scrollTo({ top: 0, behavior: 'auto' });
            }}
          />
        )}
        {activeTab === 'finance' && financeView === 'editor' && (
          <FinanceEditor
            transactionId={activeTransactionId}
            initialTransaction={
              activeTransactionId
                ? transactions.find(tx => tx.id === activeTransactionId) ?? null
                : null
            }
            user={user}
            language={language}
            inputCurrency={currency}
            banks={banks}
            subscription={subscription}
            onBack={() => {
              setFinanceView('list');
              setActiveTransactionId(null);
            }}
          />
        )}
        {activeTab === 'habits' && habitsView === 'list' && (
          <div className="fin-list__period-wrap" role="tablist">
            <button
              type="button"
              className={`fin-list__period-chip${habitsSection === 'habits' ? ' fin-list__period-chip--active' : ''}`}
              onClick={() => setHabitsSection('habits')}
            >
              {language === 'ru' ? 'Привычки' : 'Habits'}
            </button>
            <button
              type="button"
              className={`fin-list__period-chip${habitsSection === 'goals' ? ' fin-list__period-chip--active' : ''}`}
              onClick={() => setHabitsSection('goals')}
            >
              {language === 'ru' ? 'Цели' : 'Goals'}
            </button>
          </div>
        )}
        {activeTab === 'habits' && habitsView === 'list' && habitsSection === 'goals' && (
          <GoalsList user={user} language={language} />
        )}
        {activeTab === 'habits' && habitsView === 'list' && habitsSection === 'habits' && (
          <HabitsList
            language={language}
            user={user}
            habits={firestoreHabits}
            onOpenEditor={(id) => {
              setActiveHabitId(id);
              setHabitsView('editor');
              window.scrollTo({ top: 0, behavior: 'auto' });
            }}
          />
        )}
        {activeTab === 'habits' && habitsView === 'editor' && (
          <HabitEditor
            habitId={activeHabitId}
            initialHabit={
              activeHabitId
                ? firestoreHabits.find(h => h.id === activeHabitId) ?? null
                : null
            }
            user={user}
            language={language}
            subscription={subscription}
            onBack={() => {
              setHabitsView('list');
              setActiveHabitId(null);
            }}
          />
        )}
        {activeTab === 'settings' && (
          <LazySettings
            language={language}
            theme={theme}
            currency={currency}
            user={user}
            subscription={subscription}
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

      {/* ── Bottom navigation bar (5 tabs; Settings via header gear) ── */}
      <nav className="bottom-nav" aria-label="Primary navigation">
        {([
          { id: 'day-flow',  icon: <FaSun />,         label: language === 'ru' ? 'День'      : 'Day'      },
          { id: 'calendar',  icon: <FaCalendarAlt />,  label: language === 'ru' ? 'Календарь' : 'Calendar' },
          { id: 'notes',     icon: <FaStickyNote />,   label: language === 'ru' ? 'Заметки'   : 'Notes'    },
          { id: 'finance',   icon: <FaChartLine />,    label: language === 'ru' ? 'Финансы'   : 'Finance'  },
          { id: 'habits',    icon: <FaCheckCircle />,  label: language === 'ru' ? 'Привычки'  : 'Habits'   },
        ] as const).map(tab => (
          <button
            key={tab.id}
            className={`bottom-nav__item${activeTab === tab.id ? ' bottom-nav__item--active' : ''}`}
            onClick={() => handleTabSwitch(tab.id)}
            type="button"
          >
            {/* SVG icon — no emoji */}
            <span className="bottom-nav__icon">{tab.icon}</span>
            <span className="bottom-nav__label">{tab.label}</span>
          </button>
        ))}
      </nav>

    </div>
    </ToastProvider>
  );
};

export default App;
