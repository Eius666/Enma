'use strict';

const { admin, db, getUserCurrency } = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }     = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }     = require('../_lib/rateLimit');
const { checkSubscription }          = require('../_lib/ai/subscription');
const { routeMessage }               = require('../_lib/ai/router');
const { buildSystemPrompt }          = require('../_lib/ai/systemPrompt');

const TELEGRAM_API = 'https://api.telegram.org';

const RATE_LIMIT_MAX      = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ── Server-side exchange rates cache ────────────────────────────────────────
const BASE_CURRENCY       = 'USD';
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'BYN', 'CNY', 'RUB'];
const RATES_TTL_MS        = 60 * 60 * 1000; // 1 hour

let ratesCache = { rates: { USD: 1 }, fetchedAt: 0 };

async function getExchangeRates(forceRefresh = false) {
  if (!forceRefresh && ratesCache.fetchedAt && Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) {
    return ratesCache.rates;
  }
  try {
    const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`);
    if (!resp.ok) throw new Error(`Rates API returned ${resp.status}`);
    const data = await resp.json();
    const rates = { USD: 1 };
    for (const c of SUPPORTED_CURRENCIES) {
      if (c !== BASE_CURRENCY && data.rates[c]) rates[c] = data.rates[c];
    }
    ratesCache = { rates, fetchedAt: Date.now() };
    return rates;
  } catch (err) {
    console.error('[webhook] Failed to fetch exchange rates:', err);
    return ratesCache.rates;
  }
}

function convertToBase(amount, userCurrency, rates) {
  if (userCurrency === BASE_CURRENCY) return amount;
  const rate = rates[userCurrency];
  if (!rate) {
    console.warn(`[webhook] Unknown currency rate for ${userCurrency}, saving raw amount`);
    return amount;
  }
  return amount / rate;
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', BYN: 'Br', CNY: '¥', RUB: '₽' };

// ── Helpers ──────────────────────────────────────────────────────────────────

const sendTelegramMessage = async (token, chatId, text) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Basic NLP Parser for transactions.
 * Examples:
 *   "100 coffee"    → amount: 100, desc: "coffee", type: "expense"
 *   "+500 gift"     → amount: 500, desc: "gift",   type: "income"
 *   "зарплата 1000" → amount: 1000, desc: "зарплата", type: "income"
 */
const parseTransaction = (text) => {
  const clean = text.trim();
  const numMatch = clean.match(/(\d+(?:[.,]\d+)?)/);
  if (!numMatch) return null;

  const amount = parseFloat(numMatch[1].replace(',', '.'));
  if (!isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;

  const rawDescription = clean.replace(numMatch[1], '').trim() || 'No description';
  const description = rawDescription.slice(0, 500);

  let type = 'expense';
  if (
    clean.startsWith('+') ||
    clean.toLowerCase().includes('доход') ||
    clean.toLowerCase().includes('income')
  ) {
    type = 'income';
  }

  return { amount, description, type };
};

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  const sigCheck = verifyWebhookSignature(req);
  if (!sigCheck.ok) {
    console.warn('[webhook] Rejected request:', sigCheck.reason);
    res.status(200).json({ ok: true });
    return;
  }

  const ip = getClientIp(req);
  if (!await rateLimit(`webhook:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    res.status(200).json({ ok: true });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const { message } = req.body;

  if (!message || !message.text || !message.chat) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  if (!Number.isInteger(chatId) || chatId <= 0) {
    res.status(200).json({ ok: true });
    return;
  }

  const text = String(message.text).slice(0, 4096);

  try {
    // 1. Look up user by chatId from Firestore.
    const userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      await sendTelegramMessage(
        token, chatId,
        '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы мы могли привязать твой аккаунт.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    const userId = userQuery.docs[0].id; // always from Firestore, never from request body

    // 2. Handle /start command
    if (text.startsWith('/start')) {
      await sendTelegramMessage(
        token, chatId,
        'Привет! Я Enma. Ты можешь записывать расходы прямо здесь.\n' +
        'Пример: "150 кофе" или "+200 кешбэк"\n\n' +
        'А ещё — задавай любые вопросы, я AI-ассистент с подпиской.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    // 3. Try to parse as a financial transaction
    const parsed = parseTransaction(text);

    if (parsed) {
      // ── Save transaction ─────────────────────────────────────────────────
      const [userCurrency, rates] = await Promise.all([
        getUserCurrency(userId),
        getExchangeRates(),
      ]);

      const amountInBase = convertToBase(parsed.amount, userCurrency, rates);
      const transactionId = createId();
      const transaction = {
        id:               transactionId,
        userId,
        type:             parsed.type,
        amount:           amountInBase,
        originalAmount:   parsed.amount,
        originalCurrency: userCurrency,
        categoryId:       'cat-default',
        description:      parsed.description,
        date:             new Date().toISOString(),
        updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
        source:           'telegram-bot',
      };

      await db.collection('transactions').doc(transactionId).set(transaction);

      const symbol    = CURRENCY_SYMBOLS[userCurrency] || userCurrency;
      const typeLabel = parsed.type === 'income' ? 'Доход' : 'Расход';
      await sendTelegramMessage(
        token, chatId,
        `✅ Записано: ${typeLabel} ${parsed.amount}${symbol} — ${parsed.description}`
      );

    } else {
      // ── AI response (requires active subscription) ────────────────────
      const { active } = await checkSubscription(userId);

      if (!active) {
        await sendTelegramMessage(
          token, chatId,
          '🔒 Для использования AI-ассистента оформите подписку в приложении Enma.'
        );
        res.status(200).json({ ok: true });
        return;
      }

      const userCurrency = await getUserCurrency(userId);
      const firstName    = message.from?.first_name || '';
      const systemPrompt = buildSystemPrompt({ currency: userCurrency, name: firstName });

      try {
        const { response } = await routeMessage(
          [{ role: 'user', content: text }],
          systemPrompt
        );
        await sendTelegramMessage(token, chatId, response);
      } catch (aiErr) {
        console.error('[webhook] AI error:', aiErr);
        await sendTelegramMessage(token, chatId, '⚠️ AI-ассистент временно недоступен. Попробуйте позже.');
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true }); // Always 200 to Telegram
  }
};
