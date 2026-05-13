import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  format,
  parseISO,
  compareAsc,
  setHours,
  setMinutes
} from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import {
  FaMoon,
  FaSun,
} from 'react-icons/fa';
import {
  User,
  onAuthStateChanged,
  signInAnonymously,
  signOut
} from 'firebase/auth';
import { Timestamp, deleteDoc, doc, serverTimestamp, setDoc, collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import './App.v2.css';
import { auth, db } from './firebase';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';

import { AuthScreen } from './components/workspaces/AuthScreen';
import { DayFlowOverview } from './components/workspaces/DayFlowOverview';
import { CalendarWorkspace } from './components/workspaces/CalendarWorkspace';
import { NotesWorkspace } from './components/workspaces/NotesWorkspace';
import { FinanceWorkspace } from './components/workspaces/FinanceWorkspace';
import { HabitsWorkspace } from './components/workspaces/HabitsWorkspace';
import { SettingsPanel } from './components/workspaces/SettingsPanel';
import { ToastProvider } from './components/ui/Toast';

type Theme = 'dark' | 'light';
type Language = 'en' | 'ru';
type Currency = 'RUB' | 'USD' | 'EUR' | 'BYN' | 'CNY';
type PrimaryTab = 'day-flow' | 'calendar' | 'notes' | 'finance' | 'habits' | 'settings';

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
  projectId?: string;
};

type NoteProject = {
  id: string;
  name: string;
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

type Reminder = {
  id: string;
  title: string;
  date: string;
  time: string;
  notes?: string;
  done: boolean;
  notified?: boolean;
};

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-salary', name: 'Salary', type: 'income' },
  { id: 'cat-freelance', name: 'Freelance', type: 'income' },
  { id: 'cat-food', name: 'Food', type: 'expense' },
  { id: 'cat-software', name: 'Software', type: 'expense' }
];

const getDefaultCategories = (language: Language): Category[] => {
  if (language === 'ru') {
    return [
      { id: 'cat-salary', name: 'Зарплата', type: 'income' },
      { id: 'cat-freelance', name: 'Фриланс', type: 'income' },
      { id: 'cat-food', name: 'Еда', type: 'expense' },
      { id: 'cat-software', name: 'Софт', type: 'expense' }
    ];
  }
  return DEFAULT_CATEGORIES;
};

const getDefaultNoteProjects = (language: Language): NoteProject[] => [
  {
    id: 'project-default',
    name: language === 'ru' ? 'Общее' : 'General'
  }
];

const STORAGE_KEYS = {
  tasks: 'tasks',
  notes: 'notes',
  noteProjects: 'notes.projects',
  categories: 'finance.categories',
  transactions: 'finance.transactions',
  habits: 'habits',
  reminders: 'reminders'
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

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const THEME_STORAGE_KEY = 'enma.theme';
const LANGUAGE_STORAGE_KEY = 'enma.language';
const CURRENCY_STORAGE_KEY = 'enma.currency';
const RATES_STORAGE_KEY = 'enma.exchangeRates';
const RATES_TTL_MS = 60 * 60 * 1000;
const BASE_CURRENCY: Currency = 'USD';
const SUPPORTED_CURRENCIES: Currency[] = ['USD', 'EUR', 'BYN', 'CNY', 'RUB'];

const translations = {
  en: {
    authLoading: 'Checking credentials...',
    authBadge: 'Welcome back',
    authTitle: 'Access your organizer',
    authSubtitle: 'Sign in with your email to start planning your day, notes, and finances.',
    authNameLabel: 'Name',
    authNamePlaceholder: 'How should we call you?',
    authEmailLabel: 'Email',
    authEmailPlaceholder: 'you@example.com',
    authPasswordLabel: 'Password',
    authPasswordPlaceholder: 'Your secret password',
    authErrorNameRequired: 'Please share your name so we can greet you.',
    authErrorDefault: 'Unable to authenticate. Please try again.',
    authSubmitLoading: 'Please wait...',
    authSubmitSignIn: 'Sign in',
    authSubmitSignUp: 'Create account',
    authSwitchPromptSignIn: "Don't have an account yet?",
    authSwitchPromptSignUp: 'Already have an account?',
    authSwitchCreate: 'Create one',
    authSwitchSignIn: 'Sign in instead',
    toggleThemeAria: 'Toggle color theme',
    greeting: 'Hi, {name}',
    greetingFallback: 'there',
    heroSubtitle: 'The all-in-one stream for your schedule, notes, and cash flow forecast.',
    productionRefreshed: 'Production build refreshed: {date}',
    signOut: 'Sign out',
    tabDayFlow: 'day flow',
    tabCalendar: 'calendar',
    tabNotes: 'notes',
    tabFinance: 'finance',
    tabHabits: 'habits',
    tabSettings: 'settings',
    dayFlowBadge: 'Time & Money Stream',
    dayFlowTitle: "Today's overview",
    dayFlowSubtitle: 'Keep an eye on the next commitments, fresh notes, and cash flow.',
    upcomingFocus: 'Upcoming focus',
    nextLabel: 'Next:',
    caughtUp: "You're all caught up",
    addTasksHint: 'Add tasks from the calendar tab to see them here.',
    financialSnapshot: 'Financial snapshot',
    balanceLine: 'Balance {balance} · {income} in / {expenses} out',
    incomeLabel: 'Income',
    expensesLabel: 'Expenses',
    netFlowLabel: 'Net flow',
    latestNoteBadge: 'Latest note',
    latestNoteEmptyTitle: 'Create your first note to keep ideas on track',
    latestNoteUpdated: 'Updated {date}',
    latestNoteEmptyHint: 'Head to the notes tab to build your personal wiki with page blocks.',
    remindersBadge: 'Reminders',
    remindersTitle: 'Stay ahead of time-sensitive items',
    remindersEmptyHint: 'Add reminders from the calendar tab to see them here.',
    habitBadge: 'Habit tracker',
    habitTitle: 'Build routines with daily wins',
    habitCheckinTitle: 'Today’s check-in',
    habitCheckinSubtitle: 'Tap each habit you complete today.',
    habitPlaceholder: 'New habit',
    addHabit: 'Add',
    deleteHabitAria: 'Delete habit {name}',
    habitEmptyHint: 'Start by adding a habit you want to keep up this week.',
    habitCheckinEmpty: 'Add habits in the Habits tab to see daily check-ins.',
    habitsWorkspaceTitle: 'Habit workspace',
    habitsWorkspaceSubtitle: 'Create, edit, and review your weekly habits here.',
    calendarBadge: 'Calendar',
    todayButton: 'Today',
    weekdayMon: 'Mon',
    weekdayTue: 'Tue',
    weekdayWed: 'Wed',
    weekdayThu: 'Thu',
    weekdayFri: 'Fri',
    weekdaySat: 'Sat',
    weekdaySun: 'Sun',
    calendarMore: '+more',
    taskTitleLabel: 'Task title',
    taskTitlePlaceholder: 'Prep slides for sync',
    notesLabel: 'Notes',
    taskNotesPlaceholder: 'Context, links, or agenda',
    timeLabel: 'Time',
    addTask: 'Add task',
    scheduleTitle: 'Schedule',
    noTasksForDay: 'No tasks yet for this day.',
    deleteTaskAria: 'Delete task',
    reminderLabel: 'Reminder',
    reminderPlaceholder: 'Add reminder topic',
    reminderNotesPlaceholder: 'Optional notes',
    noRemindersForDay: 'No reminders scheduled for this day.',
    toggleReminderAria: 'Toggle reminder',
    deleteReminderAria: 'Delete reminder',
    notesWorkspaceTitle: 'Workspace',
    notesWorkspaceSubtitle: 'Your ideas, checklists, and quick thoughts.',
    newPage: 'New page',
    noteTypeText: 'Text',
    noteTypeChecklist: 'Checklist',
    noTextNotes: 'No text notes yet.',
    noChecklists: 'No checklists yet.',
    notesGroupToday: 'Today',
    notesGroupWeek: 'This week',
    notesGroupOlder: 'Earlier',
    notesComposerBody: 'Title, then your note...',
    addNote: 'Add note',
    notesProjectLabel: 'Project',
    notesProjectPlaceholder: 'New project name',
    addProject: 'Add project',
    deleteProjectAria: 'Delete project {name}',
    notesBack: 'Back to list',
    untitled: 'Untitled',
    noteTitlePlaceholder: 'Untitled page',
    startWriting: 'Start writing...',
    todoPlaceholder: 'Describe the task',
    textPlaceholder: 'Write your thoughts...',
    addItem: 'Add item',
    addParagraph: 'Add paragraph',
    noPageSelected: 'No page selected',
    noPageSelectedHint: 'Create or choose a page from the left panel to start writing.',
    financeBalance: 'Balance',
    financeIncome: 'Income',
    financeExpenses: 'Expenses',
    categoriesBadge: 'Categories',
    categoriesTitle: 'Group your cash flow',
    categoryNameLabel: 'Name',
    categoryNamePlaceholder: 'e.g. Subscriptions',
    categoryTypeLabel: 'Type',
    categoryTypeIncome: 'Income',
    categoryTypeExpense: 'Expense',
    addCategory: 'Add category',
    deleteCategoryAria: 'Delete category {name}',
    logTransactionTitle: 'Log a transaction',
    transactionTypeIncome: 'income',
    transactionTypeExpense: 'expense',
    amountLabel: 'Amount',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What is this for?',
    categoryLabel: 'Category',
    chooseCategory: 'Choose category',
    saveTransaction: 'Save transaction',
    recentActivity: 'Recent activity',
    noTransactions: 'No transactions logged yet.',
    deleteTransactionAria: 'Delete transaction',
    uncategorized: 'Uncategorized',
    settingsBadge: 'Settings',
    settingsTitle: 'Language & preferences',
    settingsSubtitle: 'Adjust how Enma speaks to you across the workspace.',
    languageLabel: 'Language',
    languageDescription: 'Pick the language for buttons, labels, and helper text.',
    languageOptionEnglish: 'English',
    languageOptionRussian: 'Russian',
    currencyLabel: 'Currency',
    currencyDescription: 'Choose the currency used for balances and totals.',
    currencyOptionUSD: 'US Dollar',
    currencyOptionEUR: 'Euro',
    currencyOptionBYN: 'Belarusian Ruble',
    currencyOptionCNY: 'Chinese Yuan',
    currencyOptionRUB: 'Russian Ruble',
    ratesUpdated: 'Rates updated: {date}',
    ratesUpdating: 'Updating exchange rates...',
    ratesUnavailable: 'Exchange rates unavailable. Using cached data.',
    refreshRates: 'Refresh rates',
    changesApplyInstantly: 'Changes apply instantly.',
    telegramReminderLine: 'Reminder: {title}\n{date} at {time}'
  },
  ru: {
    authLoading: 'Проверяем доступ...',
    authBadge: 'С возвращением',
    authTitle: 'Доступ к органайзеру',
    authSubtitle: 'Войдите по email, чтобы планировать день, заметки и финансы.',
    authNameLabel: 'Имя',
    authNamePlaceholder: 'Как к вам обращаться?',
    authEmailLabel: 'Email',
    authEmailPlaceholder: 'you@example.com',
    authPasswordLabel: 'Пароль',
    authPasswordPlaceholder: 'Ваш пароль',
    authErrorNameRequired: 'Пожалуйста, укажите имя, чтобы мы могли приветствовать вас.',
    authErrorDefault: 'Не удалось войти. Попробуйте еще раз.',
    authSubmitLoading: 'Подождите...',
    authSubmitSignIn: 'Войти',
    authSubmitSignUp: 'Создать аккаунт',
    authSwitchPromptSignIn: 'Еще нет аккаунта?',
    authSwitchPromptSignUp: 'Уже есть аккаунт?',
    authSwitchCreate: 'Создать',
    authSwitchSignIn: 'Войти',
    toggleThemeAria: 'Переключить тему',
    greeting: 'Привет, {name}',
    greetingFallback: 'друг',
    heroSubtitle: 'Единый центр для расписания, заметок и прогноза денег.',
    productionRefreshed: 'Продакшен обновлен: {date}',
    signOut: 'Выйти',
    tabDayFlow: 'день',
    tabCalendar: 'календарь',
    tabNotes: 'заметки',
    tabFinance: 'финансы',
    tabHabits: 'привычки',
    tabSettings: 'настройки',
    dayFlowBadge: 'Поток времени и денег',
    dayFlowTitle: 'Обзор на сегодня',
    dayFlowSubtitle: 'Следите за ближайшими делами, свежими заметками и балансом.',
    upcomingFocus: 'Ближайший фокус',
    nextLabel: 'Далее:',
    caughtUp: 'Все под контролем',
    addTasksHint: 'Добавьте задачи в календаре, чтобы они появились здесь.',
    financialSnapshot: 'Финансовый снимок',
    balanceLine: 'Баланс {balance} · приход {income} / расход {expenses}',
    incomeLabel: 'Доход',
    expensesLabel: 'Расходы',
    netFlowLabel: 'Итог',
    latestNoteBadge: 'Свежая заметка',
    latestNoteEmptyTitle: 'Создайте первую заметку, чтобы зафиксировать идеи',
    latestNoteUpdated: 'Обновлено {date}',
    latestNoteEmptyHint: 'Перейдите в заметки, чтобы собрать личную базу знаний.',
    remindersBadge: 'Напоминания',
    remindersTitle: 'Не пропускайте важные моменты',
    remindersEmptyHint: 'Добавьте напоминания в календаре, и они появятся здесь.',
    habitBadge: 'Трекер привычек',
    habitTitle: 'Закрепляйте рутину ежедневными победами',
    habitCheckinTitle: 'Отметки на сегодня',
    habitCheckinSubtitle: 'Отмечайте привычки, которые выполнили сегодня.',
    habitPlaceholder: 'Новая привычка',
    addHabit: 'Добавить',
    deleteHabitAria: 'Удалить привычку {name}',
    habitEmptyHint: 'Начните с привычки, которую хотите удерживать на этой неделе.',
    habitCheckinEmpty: 'Добавьте привычки во вкладке «Привычки», чтобы отмечать их.',
    habitsWorkspaceTitle: 'Рабочее пространство привычек',
    habitsWorkspaceSubtitle: 'Создавайте, редактируйте и отслеживайте привычки.',
    calendarBadge: 'Календарь',
    todayButton: 'Сегодня',
    weekdayMon: 'Пн',
    weekdayTue: 'Вт',
    weekdayWed: 'Ср',
    weekdayThu: 'Чт',
    weekdayFri: 'Пт',
    weekdaySat: 'Сб',
    weekdaySun: 'Вс',
    calendarMore: '+еще',
    taskTitleLabel: 'Название задачи',
    taskTitlePlaceholder: 'Подготовить слайды',
    notesLabel: 'Заметки',
    taskNotesPlaceholder: 'Контекст, ссылки или повестка',
    timeLabel: 'Время',
    addTask: 'Добавить задачу',
    scheduleTitle: 'Расписание',
    noTasksForDay: 'На этот день задач нет.',
    deleteTaskAria: 'Удалить задачу',
    reminderLabel: 'Напоминание',
    reminderPlaceholder: 'О чем напомнить?',
    reminderNotesPlaceholder: 'Доп. заметки',
    noRemindersForDay: 'На этот день напоминаний нет.',
    toggleReminderAria: 'Отметить напоминание',
    deleteReminderAria: 'Удалить напоминание',
    notesWorkspaceTitle: 'Рабочее пространство',
    notesWorkspaceSubtitle: 'Ваши идеи, чек-листы и быстрые заметки.',
    newPage: 'Новая страница',
    noteTypeText: 'Текст',
    noteTypeChecklist: 'Чек-лист',
    noTextNotes: 'Текстовых заметок пока нет.',
    noChecklists: 'Чек-листов пока нет.',
    notesGroupToday: 'Сегодня',
    notesGroupWeek: 'На этой неделе',
    notesGroupOlder: 'Ранее',
    notesComposerBody: 'Название и текст заметки...',
    addNote: 'Добавить заметку',
    notesProjectLabel: 'Проект',
    notesProjectPlaceholder: 'Новый проект',
    addProject: 'Добавить проект',
    deleteProjectAria: 'Удалить проект {name}',
    notesBack: 'Назад к списку',
    untitled: 'Без названия',
    noteTitlePlaceholder: 'Страница без названия',
    startWriting: 'Начните писать...',
    todoPlaceholder: 'Опишите задачу',
    textPlaceholder: 'Запишите мысли...',
    addItem: 'Добавить пункт',
    addParagraph: 'Добавить абзац',
    noPageSelected: 'Страница не выбрана',
    noPageSelectedHint: 'Создайте или выберите страницу слева, чтобы начать работу.',
    financeBalance: 'Баланс',
    financeIncome: 'Доход',
    financeExpenses: 'Расходы',
    categoriesBadge: 'Категории',
    categoriesTitle: 'Сгруппируйте денежный поток',
    categoryNameLabel: 'Название',
    categoryNamePlaceholder: 'например, Подписки',
    categoryTypeLabel: 'Тип',
    categoryTypeIncome: 'Доход',
    categoryTypeExpense: 'Расход',
    addCategory: 'Добавить категорию',
    deleteCategoryAria: 'Удалить категорию {name}',
    logTransactionTitle: 'Записать транзакцию',
    transactionTypeIncome: 'доход',
    transactionTypeExpense: 'расход',
    amountLabel: 'Сумма',
    descriptionLabel: 'Описание',
    descriptionPlaceholder: 'На что это?',
    categoryLabel: 'Категория',
    chooseCategory: 'Выберите категорию',
    saveTransaction: 'Сохранить транзакцию',
    recentActivity: 'Последние операции',
    noTransactions: 'Транзакций пока нет.',
    deleteTransactionAria: 'Удалить транзакцию',
    uncategorized: 'Без категории',
    settingsBadge: 'Настройки',
    settingsTitle: 'Язык и предпочтения',
    settingsSubtitle: 'Настройте стиль общения Enma в рабочем пространстве.',
    languageLabel: 'Язык',
    languageDescription: 'Выберите язык интерфейса для кнопок и подсказок.',
    languageOptionEnglish: 'Английский',
    languageOptionRussian: 'Русский',
    currencyLabel: 'Валюта',
    currencyDescription: 'Выберите валюту для отображения баланса и итогов.',
    currencyOptionUSD: 'Доллар США',
    currencyOptionEUR: 'Евро',
    currencyOptionBYN: 'Белорусский рубль',
    currencyOptionCNY: 'Китайский юань',
    currencyOptionRUB: 'Российский рубль',
    ratesUpdated: 'Курсы обновлены: {date}',
    ratesUpdating: 'Обновляем курсы...',
    ratesUnavailable: 'Курсы недоступны. Используем кеш.',
    refreshRates: 'Обновить курсы',
    changesApplyInstantly: 'Изменения применяются сразу.',
    telegramReminderLine: 'Напоминание: {title}\n{date} в {time}'
  }
} as const;

type TranslationKey = keyof typeof translations.en;

const translate = (
  language: Language,
  key: TranslationKey,
  params?: Record<string, string | number>
) => {
  const template = translations[language][key] ?? translations.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, token) => String(params[token] ?? `{${token}}`));
};

const getDateLocale = (language: Language) => (language === 'ru' ? ru : enUS);

const formatDate = (language: Language, date: Date, pattern: string) =>
  format(date, pattern, { locale: getDateLocale(language) });

const readRatesCache = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RATES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      base: Currency;
      rates: Record<string, number>;
      fetchedAt: string;
    };
    return parsed;
  } catch {
    return null;
  }
};

const writeRatesCache = (payload: {
  base: Currency;
  rates: Record<string, number>;
  fetchedAt: string;
}) => {
  try {
    localStorage.setItem(RATES_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Failed to persist exchange rates', error);
  }
};

const buildTelegramReminderText = (reminder: Reminder, language: Language) => {
  const dateLabel = formatDate(language, parseISO(reminder.date), 'MMM d, yyyy');
  return `${translate(language, 'telegramReminderLine', {
    title: reminder.title,
    date: dateLabel,
    time: reminder.time
  })}${reminder.notes ? `\n${reminder.notes}` : ''}`;
};

const getReminderScheduledDate = (reminder: Reminder) => {
  const baseDate = parseISO(reminder.date);
  const [hoursStr, minutesStr] = reminder.time.split(':');
  return setMinutes(setHours(baseDate, Number(hoursStr) || 0), Number(minutesStr) || 0);
};

const ENABLE_CLIENT_REMINDERS = process.env.REACT_APP_CLIENT_REMINDERS === 'true';

const notifyTelegramReminder = async (
  chatId: number,
  reminder: Reminder,
  language: Language
) => {
  try {
    const text = buildTelegramReminderText(reminder, language);
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chatId,
        text
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      console.warn('Telegram reminder failed', payload);
    }
  } catch (error) {
    console.warn('Failed to send Telegram reminder', error);
  }
};

const App: React.FC = () => {
  const telegram = useTelegramWebApp();

  const readStoredTheme = (): Theme | null => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  };

  const readStoredLanguage = (): Language | null => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored === 'ru' || stored === 'en' ? stored : null;
  };

  const readStoredCurrency = (): Currency | null => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(CURRENCY_STORAGE_KEY);
    return SUPPORTED_CURRENCIES.includes(stored as Currency) ? (stored as Currency) : null;
  };

  const detectInitialLanguage = () => {
    const stored = readStoredLanguage();
    if (stored) return stored;
    if (typeof navigator !== 'undefined') {
      const browser = navigator.language?.toLowerCase();
      if (browser?.startsWith('ru')) return 'ru';
    }
    return 'en';
  };

  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');
  const [hasManualTheme, setHasManualTheme] = useState<boolean>(() => readStoredTheme() !== null);
  const [language, setLanguage] = useState<Language>(() => detectInitialLanguage());
  const [hasManualLanguage, setHasManualLanguage] = useState<boolean>(
    () => readStoredLanguage() !== null
  );
  const [currency, setCurrency] = useState<Currency>(
    () => readStoredCurrency() ?? BASE_CURRENCY
  );
  const [rates, setRates] = useState<Record<string, number>>({ [BASE_CURRENCY]: 1 });
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState<string | null>(null);
  const [ratesStatus, setRatesStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [activeTab, setActiveTab] = useState<PrimaryTab>('day-flow');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const prevUserId = useRef<string | null>(null);
  const anonAttemptedRef = useRef(false);

  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [notes, setNotes] = useState<NotePage[]>([]);
  const [noteProjects, setNoteProjects] = useState<NoteProject[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);

  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

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
    if (!hasManualLanguage) return;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch (error) {
      console.warn('Failed to persist language preference', error);
    }
  }, [language, hasManualLanguage]);

  useEffect(() => {
    try {
      localStorage.setItem(CURRENCY_STORAGE_KEY, currency);
    } catch (error) {
      console.warn('Failed to persist currency preference', error);
    }
  }, [currency]);

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
    if (!telegram || hasManualLanguage) return;
    const tgLanguage = telegram.initDataUnsafe?.user?.language_code?.toLowerCase() ?? '';
    if (tgLanguage.startsWith('ru')) {
      setLanguage('ru');
      return;
    }
    if (tgLanguage) {
      setLanguage('en');
    }
  }, [telegram, hasManualLanguage]);

  useEffect(() => {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      setCurrency(BASE_CURRENCY);
    }
  }, [currency]);

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

  useEffect(() => {
    if (authLoading || user || anonAttemptedRef.current) return;
    if (!telegram?.initDataUnsafe?.user?.id) return;
    anonAttemptedRef.current = true;
    signInAnonymously(auth).catch(error => {
      console.warn('Failed to sign in anonymously', error);
    });
  }, [authLoading, user, telegram]);


  const storageKey = (uid: string, key: string) => `enma.${uid}.${key}`;

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
    const storedProjects = read<NoteProject[]>(
      STORAGE_KEYS.noteProjects,
      getDefaultNoteProjects(language)
    );
    const normalizedProjects = storedProjects.length
      ? storedProjects
      : getDefaultNoteProjects(language);
    setNoteProjects(normalizedProjects);

    const defaultProjectId = normalizedProjects[0]?.id ?? 'project-default';
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
          projectId: note.projectId ?? defaultProjectId,
          blocks: normalizedBlocks
        };
      })
    );
    const storedCategories = read<Category[]>(STORAGE_KEYS.categories, [] as Category[]);
    setCategories(storedCategories.length ? storedCategories : getDefaultCategories(language));
    setTransactions(read<Transaction[]>(STORAGE_KEYS.transactions, [] as Transaction[]));
    setHabits(read<Habit[]>(STORAGE_KEYS.habits, [] as Habit[]));
    setReminders(read<Reminder[]>(STORAGE_KEYS.reminders, [] as Reminder[]));
    setProfile(loadProfile(user.uid));
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
    localStorage.setItem(
      storageKey(user.uid, STORAGE_KEYS.noteProjects),
      JSON.stringify(noteProjects)
    );
  }, [user, noteProjects]);

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

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(
      storageKey(user.uid, STORAGE_KEYS.reminders),
      JSON.stringify(reminders)
    );
  }, [user, reminders]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    setDoc(doc(db, 'users', user.uid), {
      chatId,
      updatedAt: serverTimestamp()
    }, { merge: true }).catch(err => console.warn('Failed to sync user mapping', err));
  }, [user, telegram]);

  const persistTransactionToFirestore = useCallback(
    async (transaction: Transaction) => {
      if (!user) return;
      try {
        await setDoc(doc(db, 'transactions', transaction.id), {
          ...transaction,
          userId: user.uid,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (error) {
        console.warn('Failed to sync transaction', error);
      }
    },
    [user]
  );

  const deleteTransactionFromFirestore = useCallback(
    async (id: string) => {
      if (!user) return;
      try {
        await deleteDoc(doc(db, 'transactions', id));
      } catch (error) {
        console.warn('Failed to delete transaction from Firestore', error);
      }
    },
    [user]
  );

  const persistReminderToFirestore = useCallback(
    async (reminder: Reminder, options?: { isNew?: boolean; status?: 'pending' | 'done' }) => {
      if (!user) {
         return;
      }
      if (!telegram?.initDataUnsafe?.user?.id) {
         return;
      }
      
      const chatId = telegram.initDataUnsafe.user.id;
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
        scheduledAt: Timestamp.fromDate(scheduledAt),
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
  const transactionsBackfillRef = useRef(false);

  const refreshTransactionsFromFirestore = useCallback(async () => {
    if (!user) return;
    try {
      const q = query(collection(db, 'transactions'), where('userId', '==', user.uid), orderBy('date', 'desc'));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const cloudTransactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Transaction));
        setTransactions(cloudTransactions);
        alert(`✅ Загружено ${cloudTransactions.length} транзакций из облака`);
      } else {
        alert('ℹ️ Нет транзакций в облачной базе');
      }
    } catch (error) {
      console.warn('Failed to fetch transactions from cloud', error);
      alert('❌ Ошибка загрузки из облака');
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    
    const fetchTransactions = async () => {
      try {
        const q = query(collection(db, 'transactions'), where('userId', '==', user.uid), orderBy('date', 'desc'));
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          const cloudTransactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Transaction));
          setTransactions(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const fresh = cloudTransactions.filter(t => !existingIds.has(t.id));
            return [...fresh, ...prev].sort((a,b) => b.date.localeCompare(a.date));
          });
        }
      } catch (error) {
        console.warn('Failed to fetch transactions from cloud', error);
      }
    };

    fetchTransactions();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (transactionsBackfillRef.current) return;
    if (transactions.length === 0) {
      transactionsBackfillRef.current = true;
      return;
    }
    transactionsBackfillRef.current = true;
    transactions.forEach(tx => persistTransactionToFirestore(tx));
  }, [transactions, persistTransactionToFirestore, user]);

  useEffect(() => {
    if (!user || !telegram?.initDataUnsafe?.user?.id) return;
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
  }, [reminders, persistReminderToFirestore, telegram, user]);

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

  const updateLanguage = (next: Language) => {
    setHasManualLanguage(true);
    setLanguage(next);
  };

  const updateCurrency = (next: Currency) => {
    if (next === currency) return;
    setCurrency(next);
  };


  const loadExchangeRates = useCallback(async (force = false) => {
    const cached = readRatesCache();
    if (cached) {
      const isFresh =
        cached.base === BASE_CURRENCY &&
        Date.now() - new Date(cached.fetchedAt).getTime() < RATES_TTL_MS;
      if (!force && isFresh) {
        setRates(cached.rates);
        setRatesUpdatedAt(cached.fetchedAt);
        setRatesStatus('idle');
        return;
      }
      setRates(cached.rates);
      setRatesUpdatedAt(cached.fetchedAt);
    }

    setRatesStatus('loading');
    try {
      const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`);
      if (!response.ok) throw new Error('Failed to load exchange rates');
      const data = (await response.json()) as { rates: Record<string, number> };
      const filteredRates = SUPPORTED_CURRENCIES.reduce<Record<string, number>>((acc, code) => {
        const rate = code === BASE_CURRENCY ? 1 : data.rates?.[code];
        if (rate) acc[code] = rate;
        return acc;
      }, { [BASE_CURRENCY]: 1 });
      const fetchedAt = new Date().toISOString();
      setRates(filteredRates);
      setRatesUpdatedAt(fetchedAt);
      writeRatesCache({ base: BASE_CURRENCY, rates: filteredRates, fetchedAt });
      setRatesStatus('idle');
    } catch (error) {
      console.warn('Failed to fetch exchange rates', error);
      setRatesStatus('error');
    }
  }, []);

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

  const deleteHabit = (habitId: string) => {
    setHabits(prev => prev.filter(habit => habit.id !== habitId));
  };



  const deleteReminderFromFirestore = useCallback(
    async (reminderId: string) => {
      if (!user) return;
      try {
        await deleteDoc(doc(db, 'reminders', reminderId));
      } catch (error) {
        console.warn('Failed to delete reminder from Firestore', error);
      }
    },
    [user]
  );

  const addReminder = (date: Date, title: string, time: string, notes?: string) => {
    if (!title.trim()) return;
    const reminder: Reminder = {
      id: createId(),
      title: title.trim(),
      date: date.toISOString(),
      time,
      notes: notes?.trim() || undefined,
      done: false,
      notified: false
    };
    setReminders(prev => [...prev, reminder]);
    persistReminderToFirestore(reminder, { isNew: true, status: 'pending' });
  };

  const toggleReminder = (id: string) => {
    setReminders(prev =>
      prev.map(reminder =>
        reminder.id === id
          ? (() => {
              const next = {
                ...reminder,
                done: !reminder.done,
                notified: reminder.done ? false : reminder.notified
              };
              persistReminderToFirestore(next);
              return next;
            })()
          : reminder
      )
    );
  };

  const deleteReminder = (id: string) => {
    setReminders(prev => prev.filter(reminder => reminder.id !== id));
    deleteReminderFromFirestore(id);
  };

  useEffect(() => {
    loadExchangeRates();
  }, [loadExchangeRates]);

  const upcomingReminders = useMemo(() => {
    return [...reminders]
      .filter(reminder => !reminder.done && compareAsc(new Date(reminder.date), new Date()) >= 0)
      .sort((a, b) => compareAsc(new Date(a.date + 'T' + a.time), new Date(b.date + 'T' + b.time)))
      .slice(0, 4);
  }, [reminders]);

  const convertAmount = (amount: number) => amount * (rates[currency] ?? 1);
  const convertToBase = (amount: number) => amount / (rates[currency] ?? 1);

  const telegramName =
    telegram?.initDataUnsafe?.user &&
    ([telegram.initDataUnsafe.user.first_name, telegram.initDataUnsafe.user.last_name]
      .filter(Boolean)
      .join(' ') ||
      telegram.initDataUnsafe.user.username);

  const userDisplayName =
    profile?.displayName || telegramName || user?.email?.split('@')[0] || t('greetingFallback');
  const userEmail =
    user?.email || telegram?.initDataUnsafe?.user?.username || '—';

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
          <span className="auth-loading">{t('authLoading')}</span>
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

  const referenceDate = new Date();

  return (
    <ToastProvider>
    <div className={`app-shell theme-${theme}`}>
      <header className="hero-card">
        <div className="hero-intro">
          <span className="app-mark">Enma</span>
          <h1>
            {t('greeting', { name: userDisplayName })}
          </h1>
          <p>{t('heroSubtitle')}</p>
          <a
            className="refresh-link"
            href="https://eius666.github.io/Enma/"
            target="_blank"
            rel="noreferrer"
          >
            {t('productionRefreshed', {
              date: formatDate(language, referenceDate, 'MMM dd, yyyy p')
            })}
          </a>
          <span className="hero-email">{userEmail}</span>
        </div>
        <div className="hero-actions">
          <div className="hero-actions-left">
            <button className="sign-out-button" onClick={handleSignOut}>
              {t('signOut')}
            </button>
          </div>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={t('toggleThemeAria')}
          >
            {theme === 'dark' ? <FaSun /> : <FaMoon />}
          </button>
        </div>
      </header>

      <nav className="top-tabs" aria-label="Primary navigation">
        {([
          { id: 'day-flow', label: t('tabDayFlow') },
          { id: 'calendar', label: t('tabCalendar') },
          { id: 'notes', label: t('tabNotes') },
          { id: 'finance', label: t('tabFinance') },
          { id: 'habits', label: t('tabHabits') },
          { id: 'settings', label: t('tabSettings') }
        ] as const).map(tab => (
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
        {activeTab === 'day-flow' && (
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
        {activeTab === 'calendar' && (
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
        {activeTab === 'notes' && (
          <NotesWorkspace
            language={language}
            notes={notes}
            noteProjects={noteProjects}
            onNotesChange={setNotes}
            onNoteProjectsChange={setNoteProjects}
          />
        )}
        {activeTab === 'finance' && (
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
            onRefreshTransactions={refreshTransactionsFromFirestore}
          />
        )}
        {activeTab === 'habits' && (
          <HabitsWorkspace
            language={language}
            habits={habits}
            onAddHabit={addHabit}
            onToggleHabitDay={toggleHabitDay}
            onDeleteHabit={deleteHabit}
          />
        )}
        {activeTab === 'settings' && (
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
    </div>
    </ToastProvider>
  );
};

export default App;
