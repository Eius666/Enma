import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  format,
  parseISO,
  setHours,
  setMinutes
} from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
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
  signInAnonymously,
  signOut
} from 'firebase/auth';
import { Timestamp, doc, getDoc, serverTimestamp, setDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import './App.v2.css';
import { auth, db } from './firebase';
import { useTelegramWebApp } from './hooks/useTelegramWebApp';

import { AuthScreen } from './components/workspaces/AuthScreen';
import DayList, { DayTask } from './components/DayList';
import DayTaskEditor from './components/DayTaskEditor';
import CalendarView from './components/CalendarView';
import FinanceList from './components/FinanceList';
import FinanceEditor from './components/FinanceEditor';
import HabitsList, { HabitDoc } from './components/HabitsList';
import HabitEditor from './components/HabitEditor';
import { ToastProvider } from './components/ui/Toast';
import SettingsScreen from './components/SettingsScreen';
import NotesList from './components/NotesList';
import NoteEditor from './components/NoteEditor';
import { Subscription, isSubscriptionActive } from './subscription';
import './components/Subscription.css';
import './components/Notes.css';
import './components/Finance.css';
import './components/Habits.css';
import './components/Day.css';
import './components/Calendar.css';
import './components/AppShell.css';

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
  deadline?: string;
  notifyBefore?: number;
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
  category?: string;
  originalAmount?: number;
  originalCurrency?: Currency;
  source?: string;
};

type Habit = {
  id: string;
  title: string;
  history: Record<string, boolean>;
  reminderTime?: string;
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
  const [notesView, setNotesView] = useState<'list' | 'editor'>('list');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [financeView, setFinanceView] = useState<'list' | 'editor'>('list');
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
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [banks, setBanks] = useState<string[]>([]);

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

  // Load currency, banks, and Pro status — real-time, picks up SBP payment confirmation instantly.
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) return;
    const unsubscribe = onSnapshot(
      doc(db, 'users', uid),
      snap => {
        const data = snap.data();
        if (data?.currency && SUPPORTED_CURRENCIES.includes(data.currency as Currency)) {
          const firestoreCurrency = data.currency as Currency;
          setCurrency(firestoreCurrency);
          try { localStorage.setItem(CURRENCY_STORAGE_KEY, firestoreCurrency); } catch { /* ignore */ }
        }
        if (data && Array.isArray(data.banks)) {
          setBanks(data.banks as string[]);
        }
        if (data?.isPro && data?.subscription?.status === 'active' && data?.subscription?.endDate) {
          const sub = data.subscription as Subscription;
          if (isSubscriptionActive(sub)) {
            setSubscription(sub);
          }
        }
      },
      err => console.warn('Failed to listen to user doc', err)
    );
    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

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
  const transactionsBackfillRef = useRef(false);

  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) return;

    let mounted = true;
    let unsubscribe: (() => void) | null = null;

    // Debounce to avoid Firestore assertion errors on StrictMode double-mount
    const timer = setTimeout(() => {
      if (!mounted) return;

      // Single-field filter only: avoids requiring a composite index until
      // the userId+date index finishes building. Client-side sort applied below.
      const q = query(
        collection(db, 'transactions'),
        where('userId', '==', uid)
      );

      try {
        unsubscribe = onSnapshot(
          q,
          snapshot => {
            if (!mounted) return;
            setTransactions(prev => {
              const updated = new Map(prev.map(t => [t.id, t]));
              snapshot.docChanges().forEach(change => {
                if (change.type === 'removed') {
                  updated.delete(change.doc.id);
                } else {
                  updated.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as Transaction);
                }
              });
              // Sort by date descending (client-side)
              return Array.from(updated.values()).sort((a, b) => b.date.localeCompare(a.date));
            });
          },
          error => {
            if (!mounted) return;
            console.warn('Transaction onSnapshot error', error);
          }
        );
      } catch (error) {
        console.warn('Failed to subscribe to transactions', error);
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid ?? null]);

  // ── Firestore habits onSnapshot ───────────────────────────────────────────────
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) return;

    let mounted = true;
    let unsub: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (!mounted) return;
      const q = query(
        collection(db, 'habits'),
        where('userId', '==', uid)
      );
      try {
        unsub = onSnapshot(
          q,
          snapshot => {
            if (!mounted) return;
            setFirestoreHabits(prev => {
              const map = new Map(prev.map(h => [h.id, h]));
              snapshot.docChanges().forEach(change => {
                if (change.type === 'removed') {
                  map.delete(change.doc.id);
                } else {
                  map.set(change.doc.id, {
                    id: change.doc.id,
                    ...change.doc.data()
                  } as HabitDoc);
                }
              });
              return Array.from(map.values()).sort((a, b) => {
                const ta = (a.createdAt as { seconds?: number })?.seconds ?? 0;
                const tb = (b.createdAt as { seconds?: number })?.seconds ?? 0;
                return tb - ta;
              });
            });
          },
          err => {
            if (!mounted) return;
            console.warn('Habits onSnapshot error', err);
          }
        );
      } catch (err) {
        console.warn('Failed to subscribe to habits', err);
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
      if (unsub) unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid ?? null]);

  // ── Firestore day-tasks onSnapshot ────────────────────────────────────────────
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) return;

    let mounted = true;
    let unsub: (() => void) | null = null;

    const timer = setTimeout(() => {
      if (!mounted) return;
      const q = query(
        collection(db, 'tasks'),
        where('userId', '==', uid)
      );
      try {
        unsub = onSnapshot(
          q,
          snapshot => {
            if (!mounted) return;
            setDayTasks(prev => {
              const map = new Map(prev.map(t => [t.id, t]));
              snapshot.docChanges().forEach(change => {
                if (change.type === 'removed') {
                  map.delete(change.doc.id);
                } else {
                  map.set(change.doc.id, {
                    id: change.doc.id,
                    ...change.doc.data()
                  } as DayTask);
                }
              });
              return Array.from(map.values()).sort((a, b) => {
                const ta = (a.createdAt as { seconds?: number })?.seconds ?? 0;
                const tb = (b.createdAt as { seconds?: number })?.seconds ?? 0;
                return tb - ta;
              });
            });
          },
          err => {
            if (!mounted) return;
            console.warn('DayTasks onSnapshot error', err);
          }
        );
      } catch (err) {
        console.warn('Failed to subscribe to day tasks', err);
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
      if (unsub) unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid ?? null]);

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

  const habitReminderDateRef = useRef<string>('');

  const scheduleHabitReminder = useCallback(
    async (habit: Habit) => {
      if (!habit.reminderTime || !user || !telegram?.initDataUnsafe?.user?.id) return;
      const today = format(new Date(), 'yyyy-MM-dd');
      const [hh, mm] = habit.reminderTime.split(':').map(Number);
      const scheduledDate = new Date();
      scheduledDate.setHours(hh, mm, 0, 0);
      scheduledDate.setTime(scheduledDate.getTime() - 30_000);
      if (scheduledDate <= new Date()) return;
      const docId = `habit-${habit.id}-${today}`;
      try {
        const snap = await getDoc(doc(db, 'reminders', docId));
        if (snap.exists()) return;
        await setDoc(doc(db, 'reminders', docId), {
          id: docId,
          userId: user.uid,
          chatId: telegram.initDataUnsafe.user.id,
          type: 'habit_reminder',
          habitId: habit.id,
          title: habit.title,
          scheduledAt: Timestamp.fromDate(scheduledDate),
          status: 'pending',
          telegramText:
            language === 'ru'
              ? `🌱 Привычка: «${habit.title}» — не забудь отметить сегодня!`
              : `🌱 Habit: «${habit.title}» — don't forget to check in today!`,
          language,
          date: today,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        });
      } catch (error) {
        console.warn('Failed to schedule habit reminder', error);
      }
    },
    [user, telegram, language]
  );

  useEffect(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    if (!user || habits.length === 0 || habitReminderDateRef.current === today) return;
    habitReminderDateRef.current = today;
    habits.forEach(habit => {
      if (habit.reminderTime) scheduleHabitReminder(habit);
    });
  }, [habits, user, scheduleHabitReminder]);

  useEffect(() => {
    loadExchangeRates();
  }, [loadExchangeRates]);

  useEffect(() => {
    if (!user) {
      setSubscription(null);
      return;
    }
    // Direct doc ref — callback.js stores subscription at subscriptions/{userId}.
    // No composite index needed, guaranteed real-time.
    const unsubscribe = onSnapshot(
      doc(db, 'subscriptions', user.uid),
      snapshot => {
        if (snapshot.exists()) {
          const sub = snapshot.data() as Subscription;
          setSubscription(isSubscriptionActive(sub) ? sub : null);
        } else {
          setSubscription(null);
        }
      },
      err => console.warn('Failed to load subscription', err)
    );
    return unsubscribe;
  }, [user]);

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

  return (
    <ToastProvider>
    <div className={`app-shell theme-${theme}`}>

      {/* ── Compact header bar ── */}
      <header className="header-bar">
        <div className="header-left">
          {/* Avatar + optional PRO label below (Instagram-story style) */}
          <div className="header-avatar-wrap" aria-hidden="true">
            <div
              className={`header-avatar${subscription && isSubscriptionActive(subscription) ? ' header-avatar--pro' : ''}`}
            >
              {avatarInitials}
            </div>
            {subscription && isSubscriptionActive(subscription) && (
              <span className="header-avatar-pro-label">PRO</span>
            )}
          </div>
          <span className="header-greeting">
            {language === 'ru' ? `Привет, ${userDisplayName}` : `Hi, ${userDisplayName}`}
          </span>
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
        {activeTab === 'day-flow' && dayView === 'list' && (
          <DayList
            language={language}
            user={user}
            currency={currency}
            convertAmount={convertAmount}
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
              setNotesView('editor');
            }}
          />
        )}
        {activeTab === 'notes' && notesView === 'editor' && (
          <NoteEditor
            noteId={activeNoteId}
            user={user}
            language={language}
            onBack={() => {
              setNotesView('list');
              setActiveNoteId(null);
            }}
          />
        )}
        {activeTab === 'finance' && financeView === 'list' && (
          <FinanceList
            language={language}
            currency={currency}
            convertAmount={convertAmount}
            categories={categories}
            transactions={transactions}
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
            currency={currency}
            convertAmount={convertAmount}
            convertToBase={convertToBase}
            banks={banks}
            onBack={() => {
              setFinanceView('list');
              setActiveTransactionId(null);
            }}
          />
        )}
        {activeTab === 'habits' && habitsView === 'list' && (
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
            onBack={() => {
              setHabitsView('list');
              setActiveHabitId(null);
            }}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsScreen
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
