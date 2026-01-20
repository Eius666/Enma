import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { enUS, ru } from 'date-fns/locale';
import {
  FaArrowLeft,
  FaArrowRight,
  FaMoon,
  FaSun,
  FaPlus,
  FaTrash,
  FaTimes,
  FaTag,
  FaStickyNote,
  FaTasks
} from 'react-icons/fa';
import {
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import './App.css';
import { auth, db } from './src/firebase';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';

type Theme = 'dark' | 'light';
type Language = 'en' | 'ru';
type Currency = 'USD' | 'EUR' | 'GBP' | 'RUB';
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

const taskColorPalette = ['#7C5CFF', '#FF7EB6', '#6CFFB8', '#58A6FF', '#F7D060', '#FF9F40'];

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const THEME_STORAGE_KEY = 'enma.theme';
const LANGUAGE_STORAGE_KEY = 'enma.language';
const CURRENCY_STORAGE_KEY = 'enma.currency';
const RATES_STORAGE_KEY = 'enma.exchangeRates';
const RATES_TTL_MS = 60 * 60 * 1000;
const BASE_CURRENCY: Currency = 'USD';
const SUPPORTED_CURRENCIES: Currency[] = ['USD', 'EUR', 'GBP', 'RUB'];
const TELEGRAM_BOT_TOKEN = '8204403009:AAHEaGBlTOy4vFwG1OpHGaP3bUrGEUK0izA';

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
    currencyOptionGBP: 'British Pound',
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
    currencyOptionGBP: 'Британский фунт',
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

const getNumberLocale = (language: Language) => (language === 'ru' ? 'ru-RU' : 'en-US');

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

const notifyTelegramReminder = async (
  chatId: number,
  reminder: Reminder,
  language: Language
) => {
  try {
    const dateLabel = formatDate(language, parseISO(reminder.date), 'MMM d, yyyy');
    const text = `${translate(language, 'telegramReminderLine', {
      title: reminder.title,
      date: dateLabel,
      time: reminder.time
    })}${reminder.notes ? `\n${reminder.notes}` : ''}`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });
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
    if (!telegram?.initDataUnsafe?.user?.id) return;
    const chatId = telegram.initDataUnsafe.user.id;
    const interval = setInterval(() => {
      setReminders(prev => {
        let changed = false;
        const updated = prev.map(reminder => {
          if (reminder.done || reminder.notified) return reminder;
          const baseDate = parseISO(reminder.date);
          const [hoursStr, minutesStr] = reminder.time.split(':');
          const scheduled = setMinutes(
            setHours(baseDate, Number(hoursStr) || 0),
            Number(minutesStr) || 0
          );
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
  };

  const toggleReminder = (id: string) => {
    setReminders(prev =>
      prev.map(reminder =>
        reminder.id === id
          ? { ...reminder, done: !reminder.done, notified: reminder.done ? false : reminder.notified }
          : reminder
      )
    );
  };

  const deleteReminder = (id: string) => {
    setReminders(prev => prev.filter(reminder => reminder.id !== id));
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
  );
};

type DayFlowOverviewProps = {
  language: Language;
  currency: Currency;
  convertAmount: (amount: number) => number;
  upcomingTasks: CalendarTask[];
  financeSummary: { income: number; expenses: number; balance: number };
  latestNote?: NotePage;
  reminders: Reminder[];
  onToggleReminder: (id: string) => void;
  habits: Habit[];
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
};

type AuthScreenProps = {
  theme: Theme;
  onToggleTheme: () => void;
  initialName?: string | null;
  language: Language;
};

const AuthScreen: React.FC<AuthScreenProps> = ({
  theme,
  onToggleTheme,
  initialName,
  language
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
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
      const message =
        err instanceof Error ? err.message : t('authErrorDefault');
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
          <span className="badge badge-live">{t('authBadge')}</span>
          <h1>{t('authTitle')}</h1>
          <p>{t('authSubtitle')}</p>
        </header>

        <button
          className="theme-toggle auth-toggle"
          onClick={onToggleTheme}
          aria-label={t('toggleThemeAria')}
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'sign-up' && (
            <label className="floating-label">
              <span>{t('authNameLabel')}</span>
              <input
                type="text"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
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
              onChange={event => setEmail(event.target.value)}
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
              onChange={event => setPassword(event.target.value)}
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

const DayFlowOverview: React.FC<DayFlowOverviewProps> = ({
  language,
  currency,
  convertAmount,
  upcomingTasks,
  financeSummary,
  latestNote,
  reminders,
  onToggleReminder,
  habits,
  onToggleHabitDay
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
  const formatCurrency = (amount: number) =>
    convertAmount(amount).toLocaleString(getNumberLocale(language), {
      style: 'currency',
      currency
    });
  const reminderPreview = useMemo(() => reminders.slice(0, 4), [reminders]);
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const todayLabel = formatDate(language, new Date(), 'EEEE, MMM d');

  return (
    <section className="panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('dayFlowBadge')}</span>
          <h2>{t('dayFlowTitle')}</h2>
          <p className="panel-subtitle">{t('dayFlowSubtitle')}</p>
        </div>
      </header>

      <div className="overview-grid">
        <article className="card card-forecast">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('upcomingFocus')}</span>
              {upcomingTasks.length > 0 ? (
                <h3>
                  {t('nextLabel')} {upcomingTasks[0].title}{' '}
                  <span className="accent">
                    {formatDate(language, parseISO(upcomingTasks[0].date), 'MMM d • h:mm a')}
                  </span>
                </h3>
              ) : (
                <h3>{t('caughtUp')}</h3>
              )}
            </div>
          </div>
          <div className="card-row upcoming-list">
            {upcomingTasks.length === 0 && (
              <p className="card-row__meta">{t('addTasksHint')}</p>
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
                    {formatDate(language, parseISO(task.date), 'EEEE, MMM d · h:mm a')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="card card-timeline">
          <header className="card-heading">
            <div>
              <span className="card-badge muted">{t('financialSnapshot')}</span>
              <h3>
                {t('balanceLine', {
                  balance: formatCurrency(financeSummary.balance),
                  income: formatCurrency(financeSummary.income),
                  expenses: formatCurrency(financeSummary.expenses)
                })}
              </h3>
            </div>
          </header>
          <div className="finance-glance">
            <div className="glance-tile">
              <span className="tile-label">{t('incomeLabel')}</span>
              <span className="tile-value positive">
                {formatCurrency(financeSummary.income)}
              </span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">{t('expensesLabel')}</span>
              <span className="tile-value negative">
                -{formatCurrency(financeSummary.expenses)}
              </span>
            </div>
            <div className="glance-tile">
              <span className="tile-label">{t('netFlowLabel')}</span>
              <span className="tile-value">{formatCurrency(financeSummary.balance)}</span>
            </div>
          </div>
        </article>

        <article className="card card-presets">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('latestNoteBadge')}</span>
              {latestNote ? (
                <h3>{latestNote.title}</h3>
              ) : (
                <h3>{t('latestNoteEmptyTitle')}</h3>
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
                {t('latestNoteUpdated', {
                  date: formatDate(language, parseISO(latestNote.updatedAt), 'MMM d, h:mm a')
                })}
              </span>
            </div>
          ) : (
            <p className="card-row__meta">
              {t('latestNoteEmptyHint')}
            </p>
          )}
        </article>

        <article className="card card-reminders">
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('remindersBadge')}</span>
              <h3>{t('remindersTitle')}</h3>
            </div>
          </div>
          {reminderPreview.length === 0 ? (
            <p className="card-row__meta">{t('remindersEmptyHint')}</p>
          ) : (
            <div className="reminder-preview">
              {reminderPreview.map(reminder => (
                <div key={reminder.id} className="reminder-preview-item">
                  <div>
                    <p className="card-row__title">{reminder.title}</p>
                    <span className="card-row__meta">
                      {formatDate(language, parseISO(reminder.date), 'MMM d')} · {reminder.time}
                    </span>
                    {reminder.notes && (
                      <span className="card-row__meta reminder-note">{reminder.notes}</span>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={reminder.done}
                    onChange={() => onToggleReminder(reminder.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </article>

        <article className={`card habit-card habit-checkin ${habits.length === 0 ? 'is-empty' : ''}`}>
          <div className="card-heading">
            <div>
              <span className="card-badge muted">{t('habitBadge')}</span>
              <h3>{t('habitCheckinTitle')}</h3>
              <p className="card-row__meta habit-subtitle">{t('habitCheckinSubtitle')}</p>
            </div>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">{t('habitCheckinEmpty')}</p>
          ) : (
            <div className="habit-checkin-list">
              {habits.map(habit => {
                const isDone = habit.history[todayKey];
                return (
                  <div key={habit.id} className="habit-checkin-row">
                    <div className="habit-checkin-info">
                      <strong>{habit.title}</strong>
                      <span className="card-row__meta">{todayLabel}</span>
                    </div>
                    <button
                      className={`habit-checkin-toggle ${isDone ? 'is-done' : ''}`}
                      onClick={() => onToggleHabitDay(habit.id, todayKey)}
                      type="button"
                    >
                      {isDone ? '✓' : '○'}
                    </button>
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
  language: Language;
  tasks: CalendarTask[];
  reminders: Reminder[];
  onTasksChange: (tasks: CalendarTask[]) => void;
  onAddReminder: (date: Date, title: string, time: string, notes?: string) => void;
  onToggleReminder: (id: string) => void;
  onDeleteReminder: (id: string) => void;
};

const CalendarWorkspace: React.FC<CalendarWorkspaceProps> = ({
  language,
  tasks,
  reminders,
  onTasksChange,
  onAddReminder,
  onToggleReminder,
  onDeleteReminder
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [selectedColor, setSelectedColor] = useState(taskColorPalette[0]);
  const [draftTime, setDraftTime] = useState('09:00');
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderTime, setReminderTime] = useState('09:00');
  const [reminderNotes, setReminderNotes] = useState('');

  const tasksForSelectedDay = useMemo(() => {
    return tasks
      .filter(task => isSameDay(parseISO(task.date), selectedDate))
      .sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date)));
  }, [tasks, selectedDate]);

  const remindersForSelectedDay = useMemo(
    () =>
      reminders.filter(reminder =>
        isSameDay(parseISO(reminder.date), selectedDate)
      ),
    [reminders, selectedDate]
  );

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

  const handleAddReminder = () => {
    if (!reminderTitle.trim()) return;
    onAddReminder(selectedDate, reminderTitle, reminderTime, reminderNotes);
    setReminderTitle('');
    setReminderNotes('');
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
          <span className="panel-badge">{t('calendarBadge')}</span>
          <h2>{formatDate(language, currentDate, 'MMMM yyyy')}</h2>
        </div>
        <div className="panel-controls">
          <button className="pill-control" onClick={() => setCurrentDate(subMonths(currentDate, 1))}>
            <FaArrowLeft />
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(new Date())}>
            {t('todayButton')}
          </button>
          <button className="pill-control" onClick={() => setCurrentDate(addMonths(currentDate, 1))}>
            <FaArrowRight />
          </button>
        </div>
      </header>

      <div className="calendar-content">
        <div className="calendar-grid">
          <div className="calendar-weekday">{t('weekdayMon')}</div>
          <div className="calendar-weekday">{t('weekdayTue')}</div>
          <div className="calendar-weekday">{t('weekdayWed')}</div>
          <div className="calendar-weekday">{t('weekdayThu')}</div>
          <div className="calendar-weekday">{t('weekdayFri')}</div>
          <div className="calendar-weekday">{t('weekdaySat')}</div>
          <div className="calendar-weekday">{t('weekdaySun')}</div>
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
                <span className="calendar-date">{formatDate(language, cellDate, 'd')}</span>
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
                    <span className="calendar-more">{t('calendarMore')}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <aside className="calendar-sidebar">
          <div className="sidebar-card">
            <h3>{formatDate(language, selectedDate, 'EEEE, MMMM d')}</h3>
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
              <span>{t('taskTitleLabel')}</span>
              <input
                value={draftTitle}
                onChange={event => setDraftTitle(event.target.value)}
                placeholder={t('taskTitlePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('notesLabel')}</span>
              <textarea
                rows={3}
                value={draftNotes}
                onChange={event => setDraftNotes(event.target.value)}
                placeholder={t('taskNotesPlaceholder')}
              />
            </label>
            <label className="floating-label calendar-time-field">
              <span>{t('timeLabel')}</span>
              <input
                type="time"
                value={draftTime}
                onChange={event => setDraftTime(event.target.value)}
              />
            </label>
            <button className="primary-button add-task" onClick={addTask}>
              <FaPlus /> {t('addTask')}
            </button>
          </div>

          <div className="sidebar-card task-list-card">
            <h4>{t('scheduleTitle')}</h4>
            {tasksForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('noTasksForDay')}</p>
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
                        {formatDate(language, parseISO(task.date), 'h:mm a')}
                      </span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => deleteTask(task.id)}
                      aria-label={t('deleteTaskAria')}
                    >
                      <FaTrash />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sidebar-card reminder-card">
            <h4>{t('remindersBadge')}</h4>
            <div className="reminder-form">
              <label className="floating-label">
                <span>{t('reminderLabel')}</span>
                <input
                  value={reminderTitle}
                  onChange={event => setReminderTitle(event.target.value)}
                  placeholder={t('reminderPlaceholder')}
                />
              </label>
              <div className="reminder-time-row">
                <label className="floating-label">
                  <span>{t('timeLabel')}</span>
                  <input
                    type="time"
                    value={reminderTime}
                    onChange={event => setReminderTime(event.target.value)}
                  />
                </label>
                <button className="primary-button add-reminder-btn" onClick={handleAddReminder}>
                  <FaPlus />
                </button>
              </div>
              <label className="floating-label">
                <span>{t('notesLabel')}</span>
                <textarea
                  rows={2}
                  value={reminderNotes}
                  onChange={event => setReminderNotes(event.target.value)}
                  placeholder={t('reminderNotesPlaceholder')}
                />
              </label>
            </div>
            {remindersForSelectedDay.length === 0 ? (
              <p className="empty-hint">{t('noRemindersForDay')}</p>
            ) : (
              <ul className="reminder-list">
                {remindersForSelectedDay.map(reminder => (
                  <li key={reminder.id} className={`reminder-item ${reminder.done ? 'is-done' : ''}`}>
                    <div className="reminder-info">
                      <span className="reminder-title">{reminder.title}</span>
                      <span className="reminder-meta">
                        {formatDate(language, parseISO(reminder.date), 'MMM d')} · {reminder.time}
                      </span>
                      {reminder.notes && (
                        <span className="reminder-meta">{reminder.notes}</span>
                      )}
                    </div>
                    <div className="reminder-actions">
                      <input
                        type="checkbox"
                        checked={reminder.done}
                        onChange={() => onToggleReminder(reminder.id)}
                        aria-label={t('toggleReminderAria')}
                      />
                      <button
                        className="icon-button"
                        onClick={() => onDeleteReminder(reminder.id)}
                        aria-label={t('deleteReminderAria')}
                      >
                        <FaTrash />
                      </button>
                    </div>
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
  language: Language;
  notes: NotePage[];
  noteProjects: NoteProject[];
  onNotesChange: (notes: NotePage[]) => void;
  onNoteProjectsChange: (projects: NoteProject[]) => void;
};

const NotesWorkspace: React.FC<NotesWorkspaceProps> = ({
  language,
  notes,
  noteProjects,
  onNotesChange,
  onNoteProjectsChange
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
  const [activeNoteType, setActiveNoteType] = useState<'text' | 'checklist'>('text');
  const [composerBody, setComposerBody] = useState('');
  const [projectDraft, setProjectDraft] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(noteProjects[0]?.id ?? '');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (!noteProjects.length) return;
    if (!noteProjects.find(project => project.id === selectedProjectId)) {
      setSelectedProjectId(noteProjects[0].id);
    }
  }, [noteProjects, selectedProjectId]);

  const filteredNotes = notes.filter(note => note.noteType === activeNoteType);
  const sortedNotes = useMemo(
    () =>
      [...filteredNotes].sort((a, b) =>
        compareAsc(parseISO(b.updatedAt), parseISO(a.updatedAt))
      ),
    [filteredNotes]
  );

  const projectSections = useMemo(
    () =>
      noteProjects
        .map(project => ({
          project,
          notes: sortedNotes.filter(note => note.projectId === project.id)
        }))
        .filter(section => section.notes.length > 0),
    [noteProjects, sortedNotes]
  );

  const selectedSection = projectSections.find(
    section => section.project.id === selectedProjectId
  );

  const activeNote = activeNoteId ? notes.find(note => note.id === activeNoteId) ?? null : null;

  const addProject = () => {
    const name = projectDraft.trim();
    if (!name) return;
    const newProject: NoteProject = { id: createId(), name };
    onNoteProjectsChange([newProject, ...noteProjects]);
    setSelectedProjectId(newProject.id);
    setProjectDraft('');
  };

  const deleteProject = (projectId: string) => {
    if (noteProjects.length <= 1) return;
    const remaining = noteProjects.filter(project => project.id !== projectId);
    const fallbackId = remaining[0]?.id ?? '';
    onNoteProjectsChange(remaining);
    setSelectedProjectId(prev => (prev === projectId ? fallbackId : prev));
    onNotesChange(
      notes.map(note => ({
        ...note,
        projectId: note.projectId === projectId ? fallbackId : note.projectId
      }))
    );
  };

  const updateNote = (noteId: string, updater: (note: NotePage) => NotePage) => {
    onNotesChange(notes.map(note => (note.id === noteId ? updater(note) : note)));
  };

  const addNote = () => {
    if (!composerBody.trim()) return;
    const projectId = selectedProjectId || noteProjects[0]?.id || 'project-default';
    const [firstLine, ...restLines] = composerBody.split('\n');
    const title = firstLine?.trim() || t('noteTitlePlaceholder');
    const bodyText = restLines.join('\n').trim();
    let blocks: NoteBlock[] = [];
    if (activeNoteType === 'checklist') {
      const items = restLines.map(line => line.trim()).filter(Boolean);
      blocks = items.length
        ? items.map(item => ({ id: createId(), type: 'todo', content: item, checked: false }))
        : [{ id: createId(), type: 'todo', content: '', checked: false }];
    } else {
      blocks = [
        {
          id: createId(),
          type: 'paragraph',
          content: bodyText || t('startWriting')
        }
      ];
    }
    const newNote: NotePage = {
      id: createId(),
      title,
      updatedAt: new Date().toISOString(),
      blocks,
      noteType: activeNoteType,
      projectId
    };
    onNotesChange([newNote, ...notes]);
    setComposerBody('');
  };

  const deleteNote = (noteId: string) => {
    onNotesChange(notes.filter(note => note.id !== noteId));
  };

  const updateBlockContent = (noteId: string, blockId: string, content: string) => {
    updateNote(noteId, note => {
      const newBlocks = note.blocks.map(block =>
        block.id === blockId ? { ...block, content } : block
      );
      return { ...note, blocks: newBlocks, updatedAt: new Date().toISOString() };
    });
  };

  const addBlock = (noteId: string) => {
    updateNote(noteId, note => {
      const blockTemplate: NoteBlock =
        note.noteType === 'checklist'
          ? { id: createId(), type: 'todo', content: '', checked: false }
          : { id: createId(), type: 'paragraph', content: '' };
      return {
        ...note,
        blocks: [...note.blocks, blockTemplate],
        updatedAt: new Date().toISOString()
      };
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
    <section className="panel notes-panel notes-panel--stacked">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('notesWorkspaceTitle')}</span>
          <h2>{t('notesWorkspaceTitle')}</h2>
          <p className="panel-subtitle">{t('notesWorkspaceSubtitle')}</p>
        </div>
      </header>

      <div className="notes-board">
        <div className="notes-composer">
          <div className="notes-project-tabs">
            {noteProjects.map(project => (
              <button
                key={project.id}
                className={`notes-project-tab ${
                  selectedProjectId === project.id ? 'is-active' : ''
                }`}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <span>{project.name}</span>
                {selectedProjectId === project.id && noteProjects.length > 1 && (
                  <span
                    role="button"
                    className="notes-project-remove"
                    onClick={event => {
                      event.stopPropagation();
                      deleteProject(project.id);
                    }}
                  >
                    <FaTimes />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="notes-project-create">
            <input
              value={projectDraft}
              onChange={event => setProjectDraft(event.target.value)}
              placeholder={t('notesProjectPlaceholder')}
            />
            <button className="ghost-button" onClick={addProject}>
              <FaPlus /> {t('addProject')}
            </button>
          </div>
          <textarea
            rows={4}
            className="notes-composer-body notes-composer-body--single"
            value={composerBody}
            onChange={event => setComposerBody(event.target.value)}
            placeholder={t('notesComposerBody')}
          />
          <div className="note-type-switch">
            <button
              className={activeNoteType === 'text' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('text')}
            >
              <FaStickyNote /> {t('noteTypeText')}
            </button>
            <button
              className={activeNoteType === 'checklist' ? 'is-active' : ''}
              onClick={() => setActiveNoteType('checklist')}
            >
              <FaTasks /> {t('noteTypeChecklist')}
            </button>
          </div>
          <button className="primary-button notes-composer-submit" onClick={addNote}>
            <FaPlus /> {t('addNote')}
          </button>
        </div>

        {activeNote ? (
          <div className="note-detail">
            <button className="ghost-button note-detail-back" onClick={() => setActiveNoteId(null)}>
              {t('notesBack')}
            </button>
            <div className="note-detail-header">
              <input
                className="note-detail-title"
                value={activeNote.title}
                onChange={event =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    title: event.target.value,
                    updatedAt: new Date().toISOString()
                  }))
                }
                placeholder={t('noteTitlePlaceholder')}
              />
              <select
                className="note-detail-project"
                value={activeNote.projectId}
                onChange={event =>
                  updateNote(activeNote.id, note => ({
                    ...note,
                    projectId: event.target.value,
                    updatedAt: new Date().toISOString()
                  }))
                }
              >
                {noteProjects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="note-detail-body">
              {activeNote.blocks.map(block => (
                <div key={block.id} className="note-card-block">
                  {activeNote.noteType === 'checklist' ? (
                    <label className="note-card-todo">
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
                        placeholder={t('todoPlaceholder')}
                      />
                    </label>
                  ) : (
                    <textarea
                      rows={3}
                      className="block-textarea"
                      value={block.content}
                      onChange={event =>
                        updateBlockContent(activeNote.id, block.id, event.target.value)
                      }
                      placeholder={t('textPlaceholder')}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="note-card-actions">
              <button className="ghost-button add-block" onClick={() => addBlock(activeNote.id)}>
                <FaPlus /> {activeNote.noteType === 'checklist' ? t('addItem') : t('addParagraph')}
              </button>
            </div>
          </div>
        ) : (
          <div className="notes-stream">
            {selectedSection ? (
              <div className="note-group">
                <div className="note-group-header">
                  <h4 className="note-group-title">{selectedSection.project.name}</h4>
                  <button
                    className="icon-button"
                    onClick={() => deleteProject(selectedSection.project.id)}
                    aria-label={t('deleteProjectAria', { name: selectedSection.project.name })}
                  >
                    <FaTimes />
                  </button>
                </div>
                <div className="note-group-list">
                  {selectedSection.notes.map(note => (
                    <article
                      key={note.id}
                      className={`note-card note-card--${note.noteType}`}
                      onClick={() => setActiveNoteId(note.id)}
                    >
                      <div className="note-card-header">
                        <div>
                          <h3 className="note-card-title-text">
                            {note.title || t('noteTitlePlaceholder')}
                          </h3>
                          <span className="note-card-updated">
                            {formatDate(language, parseISO(note.updatedAt), 'MMM d · h:mm a')}
                          </span>
                        </div>
                        <button
                          className="icon-button"
                          onClick={event => {
                            event.stopPropagation();
                            deleteNote(note.id);
                          }}
                        >
                          <FaTrash />
                        </button>
                      </div>
                      <p className="note-card-preview">
                        {note.blocks[0]?.content || t('startWriting')}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="notes-empty">
                {activeNoteType === 'text' ? t('noTextNotes') : t('noChecklists')}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

type HabitsWorkspaceProps = {
  language: Language;
  habits: Habit[];
  onAddHabit: (name: string) => void;
  onToggleHabitDay: (habitId: string, dateKey: string) => void;
  onDeleteHabit: (habitId: string) => void;
};

const HabitsWorkspace: React.FC<HabitsWorkspaceProps> = ({
  language,
  habits,
  onAddHabit,
  onToggleHabitDay,
  onDeleteHabit
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
  const [habitDraft, setHabitDraft] = useState('');
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekDays = Array.from({ length: 7 }).map((_, index) => addDays(weekStart, index));
  const dayKeys = weekDays.map(day => format(day, 'yyyy-MM-dd'));

  return (
    <section className="panel habits-panel">
      <header className="panel-header">
        <div className="panel-header__titles">
          <span className="panel-badge">{t('habitBadge')}</span>
          <h2>{t('habitsWorkspaceTitle')}</h2>
          <p className="panel-subtitle">{t('habitsWorkspaceSubtitle')}</p>
        </div>
      </header>
      <div className="panel-body">
        <article className="card habit-card habit-card--compact">
          <div className="habit-card-header">
            <span className="card-badge muted">{t('habitBadge')}</span>
            <h3>{t('habitTitle')}</h3>
          </div>
          <div className="habit-add habit-add--compact">
            <input
              type="text"
              placeholder={t('habitPlaceholder')}
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
              <FaPlus /> {t('addHabit')}
            </button>
          </div>
          {habits.length === 0 ? (
            <p className="card-row__meta">{t('habitEmptyHint')}</p>
          ) : (
            <div className="habit-list">
              {habits.map(habit => {
                const completedCount = dayKeys.filter(key => habit.history[key]).length;
                const progress = Math.round((completedCount / dayKeys.length) * 100);
                return (
                  <div key={habit.id} className="habit-row">
                    <div className="habit-title">
                      <div className="habit-title-row">
                        <strong>{habit.title}</strong>
                        <div className="habit-title-actions">
                          <span className="habit-progress-label">{progress}%</span>
                          <button
                            type="button"
                            className="habit-delete"
                            onClick={() => onDeleteHabit(habit.id)}
                            aria-label={t('deleteHabitAria', { name: habit.title })}
                          >
                            <FaTrash />
                          </button>
                        </div>
                      </div>
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
                            <span className="habit-day-name">
                              {formatDate(language, day, 'EEE')[0]}
                            </span>
                            <span className="habit-day-date">
                              {formatDate(language, day, 'd')}
                            </span>
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

type FinanceWorkspaceProps = {
  language: Language;
  currency: Currency;
  convertAmount: (amount: number) => number;
  convertToBase: (amount: number) => number;
  categories: Category[];
  onCategoriesChange: (categories: Category[]) => void;
  transactions: Transaction[];
  onTransactionsChange: (transactions: Transaction[]) => void;
};

const FinanceWorkspace: React.FC<FinanceWorkspaceProps> = ({
  language,
  currency,
  convertAmount,
  convertToBase,
  categories,
  onCategoriesChange,
  transactions,
  onTransactionsChange
}) => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) =>
    translate(language, key, params);
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
      amount: convertToBase(amount),
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

  const deleteCategory = (categoryId: string) => {
    onCategoriesChange(categories.filter(category => category.id !== categoryId));
    setDraft(prev => (prev.categoryId === categoryId ? { ...prev, categoryId: '' } : prev));
  };

  const deleteTransaction = (id: string) => {
    onTransactionsChange(transactions.filter(tx => tx.id !== id));
  };

  const formatCurrency = (amount: number) =>
    convertAmount(amount).toLocaleString(getNumberLocale(language), {
      style: 'currency',
      currency
    });

  const resolveCategory = (categoryId: string) =>
    categories.find(category => category.id === categoryId)?.name ?? t('uncategorized');

  return (
    <section className="panel finance-panel">
      <div className="finance-upper">
        <div className="finance-summary-grid">
          <div className="summary-card">
            <span className="tile-label">{t('financeBalance')}</span>
            <span className="tile-value">{formatCurrency(totals.balance)}</span>
          </div>
          <div className="summary-card positive">
            <span className="tile-label">{t('financeIncome')}</span>
            <span className="tile-value">{formatCurrency(totals.income)}</span>
          </div>
          <div className="summary-card negative">
            <span className="tile-label">{t('financeExpenses')}</span>
            <span className="tile-value">-{formatCurrency(totals.expenses)}</span>
          </div>
        </div>
        <div className="category-card">
          <header>
            <span className="card-badge muted">{t('categoriesBadge')}</span>
            <h3>{t('categoriesTitle')}</h3>
          </header>
          <div className="category-quick-list">
            {categories.map(category => (
              <div key={category.id} className="category-chip">
                <FaTag />
                <span>{category.name}</span>
                <button
                  type="button"
                  className="category-remove"
                  onClick={() => deleteCategory(category.id)}
                  aria-label={t('deleteCategoryAria', { name: category.name })}
                >
                  <FaTimes />
                </button>
              </div>
            ))}
          </div>
          <div className="category-form">
            <label className="floating-label">
              <span>{t('categoryNameLabel')}</span>
              <input
                value={categoryDraft.name}
                onChange={event =>
                  setCategoryDraft(prev => ({ ...prev, name: event.target.value }))
                }
                placeholder={t('categoryNamePlaceholder')}
              />
            </label>
            <label className="floating-label">
              <span>{t('categoryTypeLabel')}</span>
              <select
                value={categoryDraft.type}
                onChange={event =>
                  setCategoryDraft(prev => ({
                    ...prev,
                    type: event.target.value as 'income' | 'expense'
                  }))
                }
              >
                <option value="income">{t('categoryTypeIncome')}</option>
                <option value="expense">{t('categoryTypeExpense')}</option>
              </select>
            </label>
            <button className="ghost-button" onClick={addCategory}>
              <FaPlus /> {t('addCategory')}
            </button>
          </div>
        </div>
      </div>

      <div className="finance-lower">
        <div className="transaction-form-card">
          <h3>{t('logTransactionTitle')}</h3>
          <div className="type-toggle">
            {(['income', 'expense'] as const).map(type => (
              <button
                key={type}
                className={`type-pill ${draft.type === type ? 'is-active' : ''}`}
                onClick={() => setDraft(prev => ({ ...prev, type, categoryId: '' }))}
              >
                {type === 'income' ? t('transactionTypeIncome') : t('transactionTypeExpense')}
              </button>
            ))}
          </div>
          <label className="floating-label">
            <span>{t('amountLabel')}</span>
            <input
              type="number"
              value={draft.amount}
              onChange={event => setDraft(prev => ({ ...prev, amount: event.target.value }))}
              placeholder="0.00"
            />
          </label>
          <label className="floating-label">
            <span>{t('descriptionLabel')}</span>
            <input
              value={draft.description}
              onChange={event =>
                setDraft(prev => ({ ...prev, description: event.target.value }))
              }
              placeholder={t('descriptionPlaceholder')}
            />
          </label>
          <label className="floating-label">
            <span>{t('categoryLabel')}</span>
            <select
              value={draft.categoryId}
              onChange={event =>
                setDraft(prev => ({ ...prev, categoryId: event.target.value }))
              }
            >
              <option value="" disabled>
                {t('chooseCategory')}
              </option>
              {relevantCategories.map(category => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button add-transaction" onClick={addTransaction}>
            <FaPlus /> {t('saveTransaction')}
          </button>
        </div>

        <div className="transactions-card">
          <h3>{t('recentActivity')}</h3>
          {transactions.length === 0 ? (
            <p className="empty-hint">{t('noTransactions')}</p>
          ) : (
            <ul className="transactions-list">
              {transactions.map(tx => (
                <li key={tx.id} className={`transaction-row ${tx.type}`}>
                  <div className="transaction-main">
                    <span className="category-tag">{resolveCategory(tx.categoryId)}</span>
                    <p className="transaction-description">{tx.description}</p>
                    <span className="transaction-date">
                      {formatDate(language, parseISO(tx.date), 'MMM d, h:mm a')}
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
                      aria-label={t('deleteTransactionAria')}
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
  const languageSelectId = 'settings-language';
  const currencySelectId = 'settings-currency';

  const ratesLabel = () => {
    if (ratesStatus === 'loading') return t('ratesUpdating');
    if (ratesStatus === 'error') return t('ratesUnavailable');
    if (!ratesUpdatedAt) return t('ratesUnavailable');
    return t('ratesUpdated', {
      date: formatDate(language, new Date(ratesUpdatedAt), 'MMM d, yyyy p')
    });
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
              <label className="settings-label" htmlFor={languageSelectId}>
                {t('languageLabel')}
              </label>
              <p>{t('languageDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id={languageSelectId}
                value={language}
                onChange={event => onLanguageChange(event.target.value as Language)}
              >
                <option value="en">{t('languageOptionEnglish')}</option>
                <option value="ru">{t('languageOptionRussian')}</option>
              </select>
              <span className="settings-hint">{t('changesApplyInstantly')}</span>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <label className="settings-label" htmlFor={currencySelectId}>
                {t('currencyLabel')}
              </label>
              <p>{t('currencyDescription')}</p>
            </div>
            <div className="settings-control">
              <select
                id={currencySelectId}
                value={currency}
                onChange={event => onCurrencyChange(event.target.value as Currency)}
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

export default App;
