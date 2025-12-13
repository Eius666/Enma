import React, { useEffect, useMemo, useState } from 'react';
import {
  format,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  isSameMonth,
  isSameDay,
  parseISO,
  compareAsc,
  setHours,
  setMinutes
} from 'date-fns';
import {
  FaArrowLeft,
  FaArrowRight,
  FaArrowRight as FaArrowRightIcon,
  FaMoon,
  FaSun,
  FaPlus,
  FaTrash,
  FaTag,
  FaStickyNote,
  FaTasks
} from 'react-icons/fa';
import {
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import './App.css';
import { auth } from './src/firebase';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';

type Theme = 'dark' | 'light';
type PrimaryTab = 'day-flow' | 'calendar' | 'notes' | 'finance';

type CalendarTask = {
  id: string;
  title: string;
  date: string;
  color: string;
  notes?: string;
};

type NoteBlock = {
  id: string;
  type: 'paragraph' | 'todo';
  content: string;
  checked?: boolean;
};

type NotePage = {
  id: string;
  title: string;
  blocks: NoteBlock[];
  updatedAt: string;
  noteType: 'text' | 'checklist';
};

type Category = {
  id: string;
  name: string;
  type: 'income' | 'expense';
};

type Transaction = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  description: string;
  date: string;
};

type Habit = {
  id: string;
  title: string;
  history: Record<string, boolean>;
};

type UserProfile = {
  displayName: string;
};

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-salary', name: 'Salary', type: 'income' },
  { id: 'cat-freelance', name: 'Freelance', type: 'income' },
  { id: 'cat-food', name: 'Food', type: 'expense' },
  { id: 'cat-software', name: 'Software', type: 'expense' }
];

const STORAGE_KEYS = {
  tasks: 'tasks',
  notes: 'notes',
  categories: 'finance.categories',
  transactions: 'finance.transactions',
  habits: 'habits'
};

const PROFILE_STORAGE_PREFIX = 'profile';

const getProfileStorageKey = (uid: string) => `enma.${uid}.${PROFILE_STORAGE_PREFIX}`;

const loadProfile = (uid: string): UserProfile | null => {
  try {
    const raw = localStorage.getItem(getProfileStorageKey(uid));
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
};

const saveProfile = (uid: string, data: UserProfile) => {
  localStorage.setItem(getProfileStorageKey(uid), JSON.stringify(data));
};

const taskColorPalette = ['#7C5CFF', '#FF7EB6', '#6CFFB8', '#58A6FF', '#F7D060', '#FF9F40'];

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const THEME_STORAGE_KEY = 'enma.theme';

const App: React.FC = () => {
  const telegram = useTelegramWebApp();

  const readStoredTheme = (): Theme | null => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  };

  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');
  const [hasManualTheme, setHasManualTheme] = useState<boolean>(() => readStoredTheme() !== null);
  const [activeTab, setActiveTab] = useState<PrimaryTab>('day-flow');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [notes, setNotes] = useState<NotePage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    if (!hasManualTheme) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn('Failed to persist theme preference', error);
    }
  }, [theme, hasManualTheme]);

  useEffect(() => {
    if (!telegram || hasManualTheme) return;
    const syncTheme = () => {
      const scheme = telegram.colorScheme === 'light' ? 'light' : 'dark';
      setTheme(scheme);
    };
    syncTheme();
    const handleThemeChange = () => syncTheme();
    telegram.onEvent?.('themeChanged', handleThemeChange);
    return () => {
      telegram.offEvent?.('themeChanged', handleThemeChange);
    };
  }, [telegram, hasManualTheme]);

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
    });
    return unsubscribe;
  }, []);

  const storageKey = (uid: string, key: string) => `enma.${uid}.${key}`;

  useEffect(() => {
    if (!user) {
      setTasks([]);
      setNotes([]);
      setCategories([]);
      setTransactions([]);
      setHabits([]);
      setProfile(null);
      setActiveTab('day-flow');
      return;
    }

    const read = <T,>(key: string, fallback: T): T => {
      try {
        const raw = localStorage.getItem(storageKey(user.uid, key));
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    setTasks(read<CalendarTask[]>(STORAGE_KEYS.tasks, [] as CalendarTask[]));
    const storedNotes = read<NotePage[]>(STORAGE_KEYS.notes, [] as NotePage[]);
    setNotes(
      storedNotes.map(note => {
        const inferredType =
          note.noteType ??
          (note.blocks.some(block => block.type === 'todo') ? 'checklist' : 'text');
        const normalizedBlocks: NoteBlock[] = note.blocks.map(block =>
          inferredType === 'checklist'
            ? {
                id: block.id,
                content: block.content,
                type: 'todo',
                checked: Boolean(block.checked)
              }
            : {
                id: block.id,
                content: block.content,
                type: 'paragraph'
              }
        );
        return {
          ...note,
          noteType: inferredType,
          blocks: normalizedBlocks
        };
      })
    );
    const storedCategories = read<Category[]>(STORAGE_KEYS.categories, [] as Category[]);
    setCategories(storedCategories.length ? storedCategories : DEFAULT_CATEGORIES);
    setTransactions(read<Transaction[]>(STORAGE_KEYS.transactions, [] as Transaction[]));
    setHabits(read<Habit[]>(STORAGE_KEYS.habits, [] as Habit[]));
    setProfile(loadProfile(user.uid));
    setActiveTab('day-flow');
  }, [user]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user) return;
    if (profile?.displayName) return;
    const tgUser = telegram.initDataUnsafe.user;
    const tgName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Friend';
    const nextProfile: UserProfile = { displayName: tgName };
    setProfile(nextProfile);
    saveProfile(user.uid, nextProfile);
  }, [telegram, user, profile]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.tasks), JSON.stringify(tasks));
  }, [user, tasks]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.notes), JSON.stringify(notes));
  }, [user, notes]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(storageKey(user.uid, STORAGE_KEYS.categories), JSON.stringify(categories));
  }, [user, categories]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(
      storageKey(user.uid, STORAGE_KEYS.transactions),
      JSON.stringify(transactions)
    );
  }, [user, transactions]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(
      storageKey(user.uid, STORAGE_KEYS.habits),
      JSON.stringify(habits)
    );
  }, [user, habits]);

  const upcomingTasks = useMemo(() => {
    const today = new Date();
    return [...tasks]
      .filter(task => compareAsc(parseISO(task.date), today) >= 0)
      .sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date)))
      .slice(0, 3);
  }, [tasks]);

  const latestNote = useMemo(() => {
    return [...notes].sort(
      (a, b) => compareAsc(parseISO(b.updatedAt), parseISO(a.updatedAt))
    )[0];
  }, [notes]);

  const financeSummary = useMemo(() => {
    const income = transactions
      .filter(tx => tx.type === 'income')
      .reduce((acc, tx) => acc + tx.amount, 0);
    const expenses = transactions
      .filter(tx => tx.type === 'expense')
      .reduce((acc, tx) => acc + tx.amount, 0);
    return {
      income,
      expenses,
      balance: income - expenses
    };
  }, [transactions]);

  const toggleTheme = () => {
    setHasManualTheme(true);
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  const addHabit = (title: string) => {
    if (!title.trim()) return;
    const newHabit: Habit = {
      id: createId(),
      title: title.trim(),
      history: {}
    };
    setHabits(prev => [...prev, newHabit]);
  };

  const toggleHabitDay = (habitId: string, dateKey: string) => {
    setHabits(prev =>
      prev.map(habit =>
        habit.id === habitId
          ? {
              ...habit,
              history: {
                ...habit.history,
                [dateKey]: !habit.history[dateKey]
              }
            }
          : habit
      )
    );
  };

  const telegramName =
    telegram?.initDataUnsafe?.user &&
    ([telegram.initDataUnsafe.user.first_name, telegram.initDataUnsafe.user.last_name]
      .filter(Boolean)
      .join(' ') ||
      telegram.initDataUnsafe.user.username);

  const userDisplayName =
    profile?.displayName || telegramName || user?.email?.split('@')[0] || 'there';

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Failed to sign out', error);
    }
  };

  if (authLoading) {
    return (
      <div className={`auth-screen theme-${theme}`}>
        <div className="auth-card loading-card">
          <span className="auth-loading">Checking credentials...</span>
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
      />
    );
  }

  const referenceDate = new Date();

  return (
    <div className={`app-shell theme-${theme}`}>
      <header className="hero-card">
        <div className="hero-intro">
          <span className="app-mark">Enma</span>
          <h1>
            Hi, {userDisplayName}
          </h1>
          <p>The all-in-one stream for your schedule, notes, and cash flow forecast.</p>
          <a
            className="refresh-link"
            href="https://eius666.github.io/Enma/"
            target="_blank"
            rel="noreferrer"
          >
            Production build refreshed: {format(referenceDate, 'MMM dd, yyyy p')}
          </a>
        </div>
        <div className="hero-actions">
          <button className="primary-button">
            Jump into the new board <FaArrowRightIcon />
          </button>
          <span className="user-chip">{user.email ?? 'Signed in'}</span>
          <button className="ghost-button" onClick={handleSignOut}>
            Sign out
          </button>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle color theme"
          >
            {theme === 'dark' ? <FaSun /> : <FaMoon />}
          </button>
        </div>
      </header>

      <nav className="top-tabs" aria-label="Primary navigation">
        {(['day-flow', 'calendar', 'notes', 'finance'] as const).map(tab => (
          <button
            key={tab}
            className={`top-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.replace('-', ' ')}
          </button>
        ))}
      </nav>

      <main className="main-content">
        {activeTab === 'day-flow' && (
          <DayFlowOverview
            upcomingTasks={upcomingTasks}
            financeSummary={financeSummary}
            latestNote={latestNote}
            habits={habits}
            onAddHabit={addHabit}
            onToggleHabitDay={toggleHabitDay}
          />
        )}
        {activeTab === 'calendar' && (
          <CalendarWorkspace tasks={tasks} onTasksChange={setTasks} />
        )}
        {activeTab === 'notes' && (
          <NotesWorkspace notes={notes} onNotesChange={setNotes} />
        )}
        {activeTab === 'finance' && (
          <FinanceWorkspace
            categories={categories}
            onCategoriesChange={setCategories}
            transactions={transactions}
            onTransactionsChange={setTransactions}
          />
        )}
      </main>
    </div>
  );
};

type DayFlowOverviewProps = {
  upcomingTasks: CalendarTask[];
  financeSummary: { income: number; expenses: number; balance: number };
  latestNote?: NotePage;
  habits: Habit[];
  onAddHabit: (name: string) => void;
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
};

type AuthScreenProps = {
  theme: Theme;
  onToggleTheme: () => void;
  initialName?: string | null;
};

const AuthScreen: React.FC<AuthScreenProps> = ({ theme, onToggleTheme, initialName }) => {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(initialName ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        throw new Error('Please share your name so we can greet you.');
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
      const message =
        err instanceof Error ? err.message : 'Unable to authenticate. Please try again.';
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
          <span className="badge badge-live">Welcome back</span>
          <h1>Access your organizer</h1>
          <p>Sign in with your email to start planning your day, notes, and finances.</p>
        </header>

        <button
          className="theme-toggle auth-toggle"
          onClick={onToggleTheme}
          aria-label="Toggle color theme"
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'sign-up' && (
            <label className="floating-label">
              <span>Name</span>
              <input
                type="text"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                placeholder="How should we call you?"
                required
                autoComplete="name"
              />
            </label>
          )}
          <label className="floating-label">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </label>
          <label className="floating-label">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="Your secret password"
              required
              minLength={6}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? 'Please wait...'
              : mode === 'sign-in'
              ? 'Sign in'
              : 'Create account'}
          </button>
        </form>

        <p className="auth-switch">
          {mode === 'sign-in' ? "Don't have an account yet?" : 'Already have an account?'}{' '}
          <button type="button" onClick={toggleMode}>
            {mode === 'sign-in' ? 'Create one' : 'Sign in instead'}
          </button>
        </p>
      </div>
    </div>
  );
};

const DayFlowOverview: React.FC<DayFlowOverviewProps> = ({
  upcomingTasks,
  financeSummary,
  latestNote,
  habits,
  onAddHabit,
  onToggleHabitDay
}) => {
  const [habitDraft, setHabitDraft] = useState('');
  const formatCurrency = (amount: number) =>
    amount.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekDays = Array.from({ length: 7 }).map((_, index) => addDays(weekStart, index));
  const dayKeys = weekDays.map(day => format(day, 'yyyy-MM-dd'));

  return (
    <section className="panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">Time &amp; Money Stream</span>
          <h2>Today&apos;s overview</h2>
          <p className="panel-subtitle">
            Keep an eye on the next commitments, fresh notes, and cash flow.
          </p>
        </div>
      </header>

      <div className="overview-grid">
        <article className="card card-forecast">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">Upcoming focus</span>
              {upcomingTasks.length > 0 ? (
                <h3>
                  Next: {upcomingTasks[0].title}{' '}
                  <span className="accent">
                    {format(parseISO(upcomingTasks[0].date), 'MMM d • h:mm a')}
                  </span>
                </h3>
              ) : (
                <h3>You&apos;re all caught up</h3>
              )}
            </div>
          </div>
          <div className="card-row upcoming-list">
            {upcomingTasks.length === 0 && (
              <p className="card-row__meta">Add tasks from the calendar tab to see them here.</p>
            )}
            {upcomingTasks.map(task => (
              <div key={task.id} className="upcoming-item">
                <span
                  className="upcoming-dot"
                  style={{ backgroundColor: task.color }}
                />
                <div className="upcoming-info">
                  <p className="card-row__title">{task.title}</p>
                  <span className="card-row__meta">
                    {format(parseISO(task.date), 'EEEE, MMM d · h:mm a')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="card card-timeline">
          <header className="card-heading">
            <div>
              <span className="card-badge muted">Financial snapshot</span>
              <h3>
                Balance {formatCurrency(financeSummary.balance)}
                <span className="card-row__meta">
                  {' '}
                  · {formatCurrency(financeSummary.income)} in /{' '}
                  {formatCurrency(financeSummary.expenses)} out
                </span>
              </h3>
            </div>
          </header>
          <div className="finance-glance">
            <div className="glance-tile">
              <span className="tile-label">Income</span>
              <span className="tile-value positive">
                {formatCurrency(financeSummary.income)}
              </span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">Expenses</span>
              <span className="tile-value negative">
                -{formatCurrency(financeSummary.expenses)}
              </span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">Net flow</span>
              <span className="tile-value">{formatCurrency(financeSummary.balance)}</span>
            </div>
          </div>
        </article>

        <article className="card card-presets">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">Latest note</span>
              {latestNote ? (
                <h3>{latestNote.title}</h3>
              ) : (
                <h3>Create your first note to keep ideas on track</h3>
              )}
            </div>
          </div>
          {latestNote ? (
            <div className="note-preview">
              {latestNote.blocks.slice(0, 3).map(block => (
                <p key={block.id} className="note-preview-line">
                  {block.type === 'todo' ? '☐ ' : ''}
                  {block.content}
                </p>
              ))}
              <span className="card-row__meta">
                Updated {format(parseISO(latestNote.updatedAt), 'MMM d, h:mm a')}
              </span>
            </div>
          ) : (
            <p className="card-row__meta">
              Head to the notes tab to build your personal wiki with page blocks.
            </p>
          )}
        </article>

        <article className="card habit-card">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">Habit tracker</span>
              <h3>Build routines with daily wins</h3>
            </div>
            <div className="habit-add">
              <input
                type="text"
                placeholder="New habit"
                value={habitDraft}
                onChange={(event) => setHabitDraft(event.target.value)}
              />
              <button
                className="ghost-button"
                onClick={() => {
                  if (!habitDraft.trim()) return;
                  onAddHabit(habitDraft);
                  setHabitDraft('');
                }}
              >
                <FaPlus /> Add
              </button>
            </div>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">Start by adding a habit you want to keep up this week.</p>
          ) : (
            <div className="habit-list">
              {habits.map(habit => {
                const completedCount = dayKeys.filter(key => habit.history[key]).length;
                const progress = Math.round((completedCount / dayKeys.length) * 100);
                return (
                  <div key={habit.id} className="habit-row">
                    <div className="habit-title">
                      <strong>{habit.title}</strong>
                      <span className="habit-progress-label">{progress}%</span>
                      <div className="habit-progress">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                    <div className="habit-days">
                      {weekDays.map((day, index) => {
                        const key = dayKeys[index];
                        const isDone = habit.history[key];
                        return (
                          <button
                            key={key}
                            className={`habit-day ${isDone ? 'is-done' : ''}`}
                            onClick={() => onToggleHabitDay(habit.id, key)}
                          >
                            <span className="habit-day-name">{format(day, 'EEE')[0]}</span>
                            <span className="habit-day-date">{format(day, 'd')}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </div>
    </section>
  );
};

type CalendarWorkspaceProps = {
  tasks: CalendarTask[];
  onTasksChange: (tasks: CalendarTask[]) => void;
};

const CalendarWorkspace: React.FC<CalendarWorkspaceProps> = ({ tasks, onTasksChange }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [selectedColor, setSelectedColor] = useState(taskColorPalette[0]);
  const [draftTime, setDraftTime] = useState('09:00');

  const tasksForSelectedDay = useMemo(() => {
    return tasks
      .filter(task => isSameDay(parseISO(task.date), selectedDate))
      .sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date)));
  }, [tasks, selectedDate]);

  const addTask = () => {
    if (!draftTitle.trim()) return;
    const [hourStr, minuteStr] = draftTime.split(':');
    const dateWithTime = setMinutes(
      setHours(new Date(selectedDate), Number(hourStr) || 0),
      Number(minuteStr) || 0
    );
    const newTask: CalendarTask = {
      id: createId(),
      title: draftTitle.trim(),
      date: dateWithTime.toISOString(),
      color: selectedColor,
      notes: draftNotes.trim() || undefined
    };
    onTasksChange([...tasks, newTask]);
    setDraftTitle('');
    setDraftNotes('');
    setDraftTime('09:00');
  };

  const deleteTask = (id: string) => {
    onTasksChange(tasks.filter(task => task.id !== id));
  };

  const startDate = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
  const endDate = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });

  const calendarCells: Date[] = [];
  let day = startDate;
  while (day <= endDate) {
    calendarCells.push(day);
    day = addDays(day, 1);
  }

  return (
    <section className="panel calendar-panel">
      <header className="panel-header calendar-header">
        <div className="panel-header__titles">
          <span className="panel-badge">Calendar</span>
          <h2>{format(currentDate, 'MMMM yyyy')}</h2>
        </div>
        <div className="panel-controls">
          <button className="pill-control" onClick={() => setCurrentDate(subMonths(currentDate, 1))}>
            <FaArrowLeft />
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(new Date())}>
            Today
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(addMonths(currentDate, 1))}>
            <FaArrowRight />
          </button>
        </div>
      </header>

      <div className="calendar-content">
        <div className="calendar-grid">
          <div className="calendar-weekday">Mon</div>
          <div className="calendar-weekday">Tue</div>
          <div className="calendar-weekday">Wed</div>
          <div className="calendar-weekday">Thu</div>
          <div className="calendar-weekday">Fri</div>
          <div className="calendar-weekday">Sat</div>
          <div className="calendar-weekday">Sun</div>
          {calendarCells.map(cellDate => {
            const dayTasks = tasks
              .filter(task => isSameDay(parseISO(task.date), cellDate))
              .slice(0, 2);
            return (
              <button
                key={cellDate.toISOString()}
                className={[
                  'calendar-cell',
                  isSameMonth(cellDate, currentDate) ? '' : 'is-faded',
                  isSameDay(cellDate, selectedDate) ? 'is-selected' : '',
                  isSameDay(cellDate, new Date()) ? 'is-today' : ''
                ].join(' ')}
                onClick={() => setSelectedDate(cellDate)}
              >
                <span className="calendar-date">{format(cellDate, 'd')}</span>
                <div className="calendar-badges">
                  {dayTasks.map(task => (
                    <span
                      key={task.id}
                      className="calendar-badge"
                      style={{ backgroundColor: task.color }}
                      title={task.title}
                    >
                      {task.title}
                    </span>
                  ))}
                  {dayTasks.length < tasks.filter(task => isSameDay(parseISO(task.date), cellDate)).length && (
                    <span className="calendar-more">+more</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <aside className="calendar-sidebar">
          <div className="sidebar-card">
            <h3>{format(selectedDate, 'EEEE, MMMM d')}</h3>
            <div className="color-palette">
              {taskColorPalette.map(color => (
                <button
                  key={color}
                  style={{ backgroundColor: color }}
                  className={`color-swatch ${selectedColor === color ? 'is-selected' : ''}`}
                  onClick={() => setSelectedColor(color)}
                />
              ))}
            </div>
            <label className="floating-label">
              <span>Task title</span>
              <input
                value={draftTitle}
                onChange={event => setDraftTitle(event.target.value)}
                placeholder="Prep slides for sync"
              />
            </label>
            <label className="floating-label">
              <span>Notes</span>
              <textarea
                rows={3}
                value={draftNotes}
                onChange={event => setDraftNotes(event.target.value)}
                placeholder="Context, links, or agenda"
              />
            </label>
            <label className="floating-label">
              <span>Time</span>
              <input
                type="time"
                value={draftTime}
                onChange={event => setDraftTime(event.target.value)}
              />
            </label>
            <button className="primary-button add-task" onClick={addTask}>
              <FaPlus /> Add task
            </button>
          </div>

          <div className="sidebar-card task-list-card">
            <h4>Schedule</h4>
            {tasksForSelectedDay.length === 0 ? (
              <p className="empty-hint">No tasks yet for this day.</p>
            ) : (
              <ul className="task-list">
                {tasksForSelectedDay.map(task => (
                  <li key={task.id} className="task-list-item">
                    <span
                      className="task-dot"
                      style={{ backgroundColor: task.color }}
                    />
                    <div className="task-info">
                      <span className="task-title">{task.title}</span>
                      {task.notes && <span className="task-note">{task.notes}</span>}
                      <span className="task-time">
                        {format(parseISO(task.date), 'h:mm a')}
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => deleteTask(task.id)}
                      aria-label="Delete task"
                    >
                      <FaTrash />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
};

type NotesWorkspaceProps = {
  notes: NotePage[];
  onNotesChange: (notes: NotePage[]) => void;
};

const NotesWorkspace: React.FC<NotesWorkspaceProps> = ({ notes, onNotesChange }) => {
  const [activeNoteType, setActiveNoteType] = useState<'text' | 'checklist'>('text');
  const [activeNoteId, setActiveNoteId] = useState('');

  useEffect(() => {
    const typedNotes = notes.filter(note => note.noteType === activeNoteType);
    if (typedNotes.length === 0) {
      setActiveNoteId('');
      return;
    }
    if (!typedNotes.find(note => note.id === activeNoteId)) {
      setActiveNoteId(typedNotes[0].id);
    }
  }, [notes, activeNoteType, activeNoteId]);

  const filteredNotes = notes.filter(note => note.noteType === activeNoteType);
  const activeNote = notes.find(note => note.id === activeNoteId);

  const updateNote = (noteId: string, updater: (note: NotePage) => NotePage) => {
    onNotesChange(notes.map(note => (note.id === noteId ? updater(note) : note)));
  };

  const addNote = () => {
    const defaultBlock: NoteBlock =
      activeNoteType === 'checklist'
        ? { id: createId(), type: 'todo', content: '', checked: false }
        : { id: createId(), type: 'paragraph', content: 'Start writing...' };
    const newNote: NotePage = {
      id: createId(),
      title: 'Untitled page',
      updatedAt: new Date().toISOString(),
      blocks: [defaultBlock],
      noteType: activeNoteType
    };
    onNotesChange([newNote, ...notes]);
    setActiveNoteId(newNote.id);
  };

  const deleteNote = (noteId: string) => {
    const filtered = notes.filter(note => note.id !== noteId);
    onNotesChange(filtered);
    const typedNotes = filtered.filter(note => note.noteType === activeNoteType);
    if (noteId === activeNoteId) {
      setActiveNoteId(typedNotes[0]?.id ?? '');
    }
  };

  const addBlock = (noteId: string, index: number) => {
    updateNote(noteId, note => {
      const newBlocks = [...note.blocks];
      const blockTemplate: NoteBlock =
        note.noteType === 'checklist'
          ? { id: createId(), type: 'todo', content: '', checked: false }
          : { id: createId(), type: 'paragraph', content: '' };
      newBlocks.splice(index + 1, 0, blockTemplate);
      return {
        ...note,
        blocks: newBlocks,
        updatedAt: new Date().toISOString()
      };
    });
  };

  const updateBlockContent = (noteId: string, blockId: string, content: string) => {
    updateNote(noteId, note => {
      const newBlocks = note.blocks.map(block =>
        block.id === blockId ? { ...block, content } : block
      );
      return { ...note, blocks: newBlocks, updatedAt: new Date().toISOString() };
    });
  };

  const toggleTodo = (noteId: string, blockId: string) => {
    updateNote(noteId, note => {
      const newBlocks = note.blocks.map(block =>
        block.id === blockId ? { ...block, checked: !block.checked } : block
      );
      return { ...note, blocks: newBlocks, updatedAt: new Date().toISOString() };
    });
  };

  return (
    <section className="panel notes-panel">
      <div className="notes-shell">
        <aside className="notes-sidebar">
          <div className="sidebar-card">
            <div className="sidebar-header">
              <h3>Workspace</h3>
              <button className="primary-button ghost" onClick={addNote}>
                <FaPlus /> New page
              </button>
            </div>
            <div className="note-type-switch">
              <button
                className={activeNoteType === 'text' ? 'is-active' : ''}
                onClick={() => setActiveNoteType('text')}
              >
                <FaStickyNote /> Text
              </button>
              <button
                className={activeNoteType === 'checklist' ? 'is-active' : ''}
                onClick={() => setActiveNoteType('checklist')}
              >
                <FaTasks /> Checklist
              </button>
            </div>
            <ul className="notes-list">
              {filteredNotes.length === 0 ? (
                <li className="notes-list-empty">
                  No {activeNoteType === 'text' ? 'text notes' : 'checklists'} yet.
                </li>
              ) : (
                filteredNotes.map(note => (
                  <li
                    key={note.id}
                    className={`notes-list-item ${note.id === activeNoteId ? 'is-active' : ''}`}
                  >
                    <button onClick={() => setActiveNoteId(note.id)}>
                      <span className="note-title">
                        {note.title || 'Untitled'}
                      </span>
                      <span className="note-updated">
                        {format(parseISO(note.updatedAt), 'MMM d · h:mm a')}
                      </span>
                    </button>
                    <button className="icon-button" onClick={() => deleteNote(note.id)}>
                      <FaTrash />
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </aside>

        <div className="notes-editor">
          {activeNote ? (
            <div className="editor-card">
              <input
                className="note-title-input"
                value={activeNote.title}
                onChange={event =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    title: event.target.value,
                    updatedAt: new Date().toISOString()
                  }))
                }
                placeholder="Untitled page"
              />

              <div className="blocks">
                {activeNote.blocks.map((block, index) => (
                  <div key={block.id} className={`note-block note-block--${activeNote.noteType}`}>
                    {activeNote.noteType === 'checklist' ? (
                      <label className="todo-block">
                        <input
                          type="checkbox"
                          checked={Boolean(block.checked)}
                          onChange={() => toggleTodo(activeNote.id, block.id)}
                        />
                        <input
                          className="block-input"
                          value={block.content}
                          onChange={event =>
                            updateBlockContent(activeNote.id, block.id, event.target.value)
                          }
                          placeholder="Describe the task"
                        />
                      </label>
                    ) : (
                      <textarea
                        rows={2}
                        className="block-textarea"
                        value={block.content}
                        onChange={event =>
                          updateBlockContent(activeNote.id, block.id, event.target.value)
                        }
                        onKeyDown={event => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            addBlock(activeNote.id, index);
                          }
                        }}
                        placeholder="Write your thoughts..."
                      />
                    )}
                  </div>
                ))}
                <button
                  className="ghost-button add-block"
                  onClick={() => addBlock(activeNote.id, activeNote.blocks.length - 1)}
                >
                  <FaPlus /> Add {activeNote.noteType === 'checklist' ? 'item' : 'paragraph'}
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-note">
              <h3>No page selected</h3>
              <p>Create or choose a page from the left panel to start writing.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

type FinanceWorkspaceProps = {
  categories: Category[];
  onCategoriesChange: (categories: Category[]) => void;
  transactions: Transaction[];
  onTransactionsChange: (transactions: Transaction[]) => void;
};

const FinanceWorkspace: React.FC<FinanceWorkspaceProps> = ({
  categories,
  onCategoriesChange,
  transactions,
  onTransactionsChange
}) => {
  const [draft, setDraft] = useState({
    type: 'income' as 'income' | 'expense',
    amount: '',
    description: '',
    categoryId: '' as string
  });
  const [categoryDraft, setCategoryDraft] = useState<{ name: string; type: 'income' | 'expense' }>({
    name: '',
    type: 'expense'
  });

  useEffect(() => {
    if (!draft.categoryId) {
      const defaultCategory = categories.find(category => category.type === draft.type);
      if (defaultCategory) {
        setDraft(prev => ({ ...prev, categoryId: defaultCategory.id }));
      }
    }
  }, [draft.type, draft.categoryId, categories]);

  const relevantCategories = categories.filter(category => category.type === draft.type);

  const totals = useMemo(() => {
    const income = transactions
      .filter(tx => tx.type === 'income')
      .reduce((sum, tx) => sum + tx.amount, 0);
    const expenses = transactions
      .filter(tx => tx.type === 'expense')
      .reduce((sum, tx) => sum + tx.amount, 0);
    return {
      income,
      expenses,
      balance: income - expenses
    };
  }, [transactions]);

  const addTransaction = () => {
    const amount = parseFloat(draft.amount);
    if (!draft.description.trim() || !amount || !draft.categoryId) return;
    const transaction: Transaction = {
      id: createId(),
      type: draft.type,
      amount,
      categoryId: draft.categoryId,
      description: draft.description.trim(),
      date: new Date().toISOString()
    };
    onTransactionsChange([transaction, ...transactions]);
    setDraft({ ...draft, amount: '', description: '' });
  };

  const addCategory = () => {
    if (!categoryDraft.name.trim()) return;
    const newCategory: Category = {
      id: createId(),
      name: categoryDraft.name.trim(),
      type: categoryDraft.type
    };
    onCategoriesChange([...categories, newCategory]);
    setCategoryDraft({ name: '', type: 'expense' });
  };

  const deleteTransaction = (id: string) => {
    onTransactionsChange(transactions.filter(tx => tx.id !== id));
  };

  const formatCurrency = (amount: number) =>
    amount.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });

  const resolveCategory = (categoryId: string) =>
    categories.find(category => category.id === categoryId)?.name ?? 'Uncategorized';

  return (
    <section className="panel finance-panel">
      <div className="finance-header">
        <div className="finance-summary-grid">
          <div className="summary-card">
            <span className="tile-label">Balance</span>
            <span className="tile-value">{formatCurrency(totals.balance)}</span>
          </div>
          <div className="summary-card positive">
            <span className="tile-label">Income</span>
            <span className="tile-value">{formatCurrency(totals.income)}</span>
          </div>
          <div className="summary-card negative">
            <span className="tile-label">Expenses</span>
            <span className="tile-value">-{formatCurrency(totals.expenses)}</span>
          </div>
        </div>
        <div className="category-card">
          <header>
            <span className="card-badge muted">Categories</span>
            <h3>Group your cash flow</h3>
          </header>
          <div className="category-quick-list">
            {categories.map(category => (
              <span key={category.id} className="category-chip">
                <FaTag /> {category.name}
              </span>
            ))}
          </div>
          <div className="category-form">
            <label className="floating-label">
              <span>Name</span>
              <input
                value={categoryDraft.name}
                onChange={event =>
                  setCategoryDraft(prev => ({ ...prev, name: event.target.value }))
                }
                placeholder="e.g. Subscriptions"
              />
            </label>
            <label className="floating-label">
              <span>Type</span>
              <select
                value={categoryDraft.type}
                onChange={event =>
                  setCategoryDraft(prev => ({
                    ...prev,
                    type: event.target.value as 'income' | 'expense'
                  }))
                }
              >
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
            </label>
            <button className="ghost-button" onClick={addCategory}>
              <FaPlus /> Add category
            </button>
          </div>
        </div>
      </div>

      <div className="finance-body">
        <div className="transaction-form-card">
          <h3>Log a transaction</h3>
          <div className="type-toggle">
            {(['income', 'expense'] as const).map(type => (
              <button
                key={type}
                className={`type-pill ${draft.type === type ? 'is-active' : ''}`}
                onClick={() => setDraft(prev => ({ ...prev, type, categoryId: '' }))}
              >
                {type}
              </button>
            ))}
          </div>
          <label className="floating-label">
            <span>Amount</span>
            <input
              type="number"
              value={draft.amount}
              onChange={event => setDraft(prev => ({ ...prev, amount: event.target.value }))}
              placeholder="0.00"
            />
          </label>
          <label className="floating-label">
            <span>Description</span>
            <input
              value={draft.description}
              onChange={event =>
                setDraft(prev => ({ ...prev, description: event.target.value }))
              }
              placeholder="What is this for?"
            />
          </label>
          <label className="floating-label">
            <span>Category</span>
            <select
              value={draft.categoryId}
              onChange={event =>
                setDraft(prev => ({ ...prev, categoryId: event.target.value }))
              }
            >
              <option value="" disabled>
                Choose category
              </option>
              {relevantCategories.map(category => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button add-transaction" onClick={addTransaction}>
            <FaPlus /> Save transaction
          </button>
        </div>

        <div className="transactions-card">
          <h3>Recent activity</h3>
          {transactions.length === 0 ? (
            <p className="empty-hint">No transactions logged yet.</p>
          ) : (
            <ul className="transactions-list">
              {transactions.map(tx => (
                <li key={tx.id} className={`transaction-row ${tx.type}`}>
                  <div className="transaction-main">
                    <span className="category-tag">{resolveCategory(tx.categoryId)}</span>
                    <p className="transaction-description">{tx.description}</p>
                    <span className="transaction-date">
                      {format(parseISO(tx.date), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  <div className="transaction-meta">
                    <span className="transaction-amount">
                      {tx.type === 'income' ? '+' : '-'}
                      {formatCurrency(tx.amount)}
                    </span>
                    <button
                      className="icon-button"
                      onClick={() => deleteTransaction(tx.id)}
                      aria-label="Delete transaction"
                    >
                      <FaTrash />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};

export default App;
