const { admin, db } = require('../_lib/firebaseAdmin');

const TELEGRAM_API = 'https://api.telegram.org';

const verifyTelegramSignature = (req) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;
  return req.headers['x-telegram-bot-api-secret-token'] === secret;
};

const sendTelegramMessage = async (token, chatId, text, options = {}) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...options })
  });
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const incomeRegex = /(^|\s)(доход|income)(?=\s|$|[.,!?])/i;
const expenseRegex = /(^|\s)(расход|expense)(?=\s|$|[.,!?])/i;
const amountRegex = /([+-]?\d+(?:[.,]\d+)?)/;
const BASE_CURRENCY = 'USD';
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'RUB'];
const RATES_TTL_MS = 60 * 60 * 1000;
let cachedRates = null;
let cachedRatesAt = 0;
const typeKeyboard = {
  reply_markup: {
    keyboard: [[{ text: 'Доход' }, { text: 'Расход' }]],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};
const confirmKeyboard = {
  reply_markup: {
    keyboard: [[{ text: 'Да' }, { text: 'Нет' }]],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
};

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildDateFromParts = (year, month, day) => {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

const findDateInText = (text, now) => {
  const lower = text.toLowerCase();
  if (lower.includes('сегодня')) {
    return { date: formatDate(now), matchedText: 'сегодня' };
  }
  if (lower.includes('вчера')) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return { date: formatDate(yesterday), matchedText: 'вчера' };
  }

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const [year, month, day] = isoMatch[1].split('-').map(Number);
    const parsed = buildDateFromParts(year, month, day);
    if (parsed) {
      return { date: formatDate(parsed), matchedText: isoMatch[1] };
    }
  }

  const dotMatch = text.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
  if (dotMatch) {
    const [day, month, year] = dotMatch[1].split('.').map(Number);
    const parsed = buildDateFromParts(year, month, day);
    if (parsed) {
      return { date: formatDate(parsed), matchedText: dotMatch[1] };
    }
  }

  return null;
};

const detectType = (text, amountMatch) => {
  const lower = text.toLowerCase();
  const hasIncome = incomeRegex.test(lower);
  const hasExpense = expenseRegex.test(lower);
  if (hasIncome && hasExpense) return null;
  if (hasIncome) return 'income';
  if (hasExpense) return 'expense';

  const signMatch = text.match(/(^|\s)([+-])\s*\d/);
  if (signMatch) {
    return signMatch[2] === '+' ? 'income' : 'expense';
  }

  if (amountMatch && amountMatch[1].startsWith('-')) return 'expense';
  if (amountMatch && amountMatch[1].startsWith('+')) return 'income';

  return null;
};

const parseAmount = (raw) => {
  const normalized = raw.replace(',', '.').replace(/[+-]/g, '');
  return Number.parseFloat(normalized);
};

const detectCurrency = (text, defaultCurrency) => {
  const lower = text.toLowerCase();
  if (lower.includes('$') || /\b(usd)\b/.test(lower)) return 'USD';
  if (lower.includes('€') || /\b(eur)\b/.test(lower)) return 'EUR';
  if (lower.includes('£') || /\b(gbp)\b/.test(lower)) return 'GBP';
  if (lower.includes('₽') || /\b(rub)\b/.test(lower)) return 'RUB';
  return defaultCurrency;
};

const stripCurrencyTokens = (text) =>
  text
    .replace(/\b(usd|eur|gbp|rub)\b/gi, ' ')
    .replace(/[€$₽£]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cleanDescription = (text) =>
  text.replace(/^[,.:;-]+/, '').replace(/\s+/g, ' ').trim();

const formatCurrency = (amount, currency) => {
  const symbol =
    currency === 'USD' ? '$' :
    currency === 'EUR' ? '€' :
    currency === 'GBP' ? '£' :
    '₽';
  const formatted = Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
  return `${formatted} ${symbol}`;
};

const normalizeCurrency = (value) =>
  SUPPORTED_CURRENCIES.includes(value) ? value : BASE_CURRENCY;

const buildDateTime = (dateString, messageDate) => {
  if (!dateString) return messageDate.toISOString();
  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return messageDate.toISOString();
  }
  const [year, month, day] = parts;
  const hours = messageDate.getUTCHours();
  const minutes = messageDate.getUTCMinutes();
  const seconds = messageDate.getUTCSeconds();
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)).toISOString();
};

const getExchangeRates = async () => {
  if (cachedRates && Date.now() - cachedRatesAt < RATES_TTL_MS) {
    return cachedRates;
  }

  const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`);
  if (!response.ok) {
    throw new Error('Failed to load exchange rates');
  }
  const data = await response.json();
  const rates = SUPPORTED_CURRENCIES.reduce((acc, code) => {
    if (code === BASE_CURRENCY) {
      acc[code] = 1;
      return acc;
    }
    const rate = data.rates?.[code];
    if (rate) {
      acc[code] = rate;
    }
    return acc;
  }, { [BASE_CURRENCY]: 1 });

  cachedRates = rates;
  cachedRatesAt = Date.now();
  return rates;
};

const convertToBase = (amount, currency, rates) => {
  if (currency === BASE_CURRENCY) return amount;
  const rate = rates?.[currency];
  if (!rate) return amount;
  return amount / rate;
};

const parseTransactionInput = (text, defaultCurrency, now = new Date()) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: { code: 'missing_amount', message: 'Empty input' } };
  }

  const dateMatch = findDateInText(trimmed, now);
  const date = dateMatch ? dateMatch.date : formatDate(now);
  const textWithoutDate = dateMatch
    ? trimmed.replace(new RegExp(dateMatch.matchedText, 'i'), ' '.repeat(dateMatch.matchedText.length))
    : trimmed;

  const amountMatch = textWithoutDate.match(amountRegex);
  if (!amountMatch) {
    return { error: { code: 'missing_amount', message: 'Amount not found' } };
  }

  const amountValue = parseAmount(amountMatch[1]);
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return { error: { code: 'invalid_amount', message: 'Amount must be positive' } };
  }

  const currency = detectCurrency(trimmed, normalizeCurrency(defaultCurrency));
  const amountIndex = amountMatch.index ?? -1;
  let description = amountIndex >= 0
    ? trimmed.slice(amountIndex + amountMatch[0].length)
    : '';

  if (dateMatch) {
    const dateRegex = new RegExp(dateMatch.matchedText, 'i');
    description = description.replace(dateRegex, ' ');
  }

  description = stripCurrencyTokens(description);
  description = cleanDescription(description);

  const type = detectType(trimmed, amountMatch);
  if (!type) {
    return {
      error: { code: 'missing_type', message: 'Transaction type not found' },
      partial: {
        amount: amountValue,
        currency,
        description: description || undefined,
        date
      }
    };
  }

  return {
    transaction: {
      type,
      amount: amountValue,
      currency,
      description: description || undefined,
      date
    }
  };
};

const buildConfirmMessage = (transaction) => {
  const typeLabel = transaction.type === 'income' ? 'Доход' : 'Расход';
  const parts = [`Добавить: ${typeLabel} ${formatCurrency(transaction.amount, transaction.currency)}`];
  if (transaction.description) {
    parts.push(`описание: ${transaction.description}`);
  }
  parts.push(`дата: ${transaction.date}`);
  return `${parts.join(', ')}. Подтвердить? (да/нет)`;
};

const isYes = (text) => ['да', 'yes', 'y'].includes(text.trim().toLowerCase());
const isNo = (text) => ['нет', 'no', 'n'].includes(text.trim().toLowerCase());

// Match description text against the user's categories.
// Returns the categoryId of the best matching category of the given type,
// or the first category of that type as a fallback.
const matchCategory = (description, type, categories) => {
  if (!Array.isArray(categories) || !categories.length) return 'cat-default';
  const relevant = categories.filter(c => c.type === type);
  if (!relevant.length) return 'cat-default';
  if (description) {
    const lower = description.toLowerCase();
    for (const cat of relevant) {
      if (lower.includes(cat.name.toLowerCase())) return cat.id;
    }
  }
  return relevant[0].id;
};

const buildTransactionRecord = (userId, parsed, baseAmount, dateTime, categories) => ({
  id: createId(),
  userId,
  type: parsed.type,
  amount: baseAmount,
  categoryId: matchCategory(parsed.description, parsed.type, categories),
  description: parsed.description || 'No description',
  date: dateTime,
  currency: parsed.currency,
  originalAmount: parsed.amount,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  source: 'telegram-bot'
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  if (!verifyTelegramSignature(req)) {
    res.status(401).json({ ok: false, description: 'Unauthorized' });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const autoConfirm = parseBoolean(process.env.TELEGRAM_AUTO_CONFIRM || process.env.AUTO_CONFIRM, false);
  const { message } = req.body;

  if (!message || !message.text || !message.chat) {
    res.status(200).json({ ok: true });
    return;
  }

    const chatId = message.chat.id;
    const text = message.text;
    const messageDate = new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000);
    const sessionRef = db.collection('telegramSessions').doc(`tg_${chatId}`);

  try {
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await sendTelegramMessage(
        token,
        chatId,
        'Привет! Я Enma. Ты можешь записывать транзакции прямо здесь.\nПример: "расход 150 кофе", "+200 кешбэк", "income 20 $ lunch"'
      );
      res.status(200).json({ ok: true });
      return;
    }

    const userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      await sendTelegramMessage(
        token,
        chatId,
        '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы мы могли привязать твой аккаунт.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    const userDoc = userQuery.docs[0];
    const userId = userDoc.id;
    const userData = userDoc.data() || {};
    const userCurrency = normalizeCurrency(userData.currency);
    const userCategories = Array.isArray(userData.categories) ? userData.categories : [];
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : null;

    if (session && session.state === 'awaiting_confirmation' && session.transaction) {
      if (isYes(text)) {
        const transactionToSave = {
          ...session.transaction,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('transactions').doc(session.transaction.id).set(transactionToSave);
        await sessionRef.delete();
        await sendTelegramMessage(token, chatId, 'Добавлено ✅');
        res.status(200).json({ ok: true });
        return;
      }
      if (isNo(text)) {
        await sessionRef.delete();
        await sendTelegramMessage(token, chatId, 'Ок, отменено.');
        res.status(200).json({ ok: true });
        return;
      }
      await sendTelegramMessage(token, chatId, 'Пожалуйста, ответьте "да" или "нет".');
      res.status(200).json({ ok: true });
      return;
    }

    if (session && session.state === 'awaiting_type' && session.partial) {
      if (/\d/.test(text)) {
        await sessionRef.delete();
      } else {
        const type = detectType(text, null);
        if (!type) {
          await sendTelegramMessage(token, chatId, 'Напишите "доход" или "расход".', typeKeyboard);
          res.status(200).json({ ok: true });
          return;
        }

        const parsed = { ...session.partial, type };
        const dateTime = buildDateTime(parsed.date, messageDate);
        let baseAmount = parsed.amount;
        try {
          const rates = await getExchangeRates();
          baseAmount = convertToBase(parsed.amount, parsed.currency, rates);
        } catch (error) {
          console.warn('Failed to convert currency, saving original amount', error);
        }
        const transactionRecord = buildTransactionRecord(userId, parsed, baseAmount, dateTime, userCategories);

        if (autoConfirm) {
          await db.collection('transactions').doc(transactionRecord.id).set(transactionRecord);
          await sessionRef.delete();
          await sendTelegramMessage(token, chatId, 'Добавлено ✅');
          res.status(200).json({ ok: true });
          return;
        }

        await sessionRef.set({
          state: 'awaiting_confirmation',
          transaction: transactionRecord,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await sendTelegramMessage(token, chatId, buildConfirmMessage(parsed), confirmKeyboard);
        res.status(200).json({ ok: true });
        return;
      }
    }

    const parsedResult = parseTransactionInput(text, userCurrency);

    if (parsedResult.error) {
      if (parsedResult.error.code === 'missing_type') {
        await sessionRef.set({
          state: 'awaiting_type',
          partial: parsedResult.partial,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await sendTelegramMessage(token, chatId, 'Не понял тип. Это доход или расход?', typeKeyboard);
        res.status(200).json({ ok: true });
        return;
      }
      if (parsedResult.error.code === 'missing_amount') {
        await sendTelegramMessage(token, chatId, 'Не нашел сумму. Напишите, например: "расход 450 кофе".');
        res.status(200).json({ ok: true });
        return;
      }

      await sendTelegramMessage(token, chatId, 'Сумма должна быть больше 0.');
      res.status(200).json({ ok: true });
      return;
    }

    const parsed = parsedResult.transaction;
    const dateTime = buildDateTime(parsed.date, messageDate);
    let baseAmount = parsed.amount;
    try {
      const rates = await getExchangeRates();
      baseAmount = convertToBase(parsed.amount, parsed.currency, rates);
    } catch (error) {
      console.warn('Failed to convert currency, saving original amount', error);
    }
    const transactionRecord = buildTransactionRecord(userId, parsed, baseAmount, dateTime);

    if (autoConfirm) {
      await db.collection('transactions').doc(transactionRecord.id).set(transactionRecord);
      await sendTelegramMessage(token, chatId, 'Добавлено ✅');
      res.status(200).json({ ok: true });
      return;
    }

    await sessionRef.set({
      state: 'awaiting_confirmation',
      transaction: transactionRecord,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await sendTelegramMessage(token, chatId, buildConfirmMessage(parsed), confirmKeyboard);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true });
  }
};
