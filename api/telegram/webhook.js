'use strict';

const { admin, db } = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature } = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp } = require('../_lib/rateLimit');

const TELEGRAM_API = 'https://api.telegram.org';

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

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

  // Strip the number from the description and sanitize.
  const rawDescription = clean.replace(numMatch[1], '').trim() || 'No description';
  const description = rawDescription.slice(0, 500); // hard cap

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  // --- Webhook signature verification ---
  // Validates the X-Telegram-Bot-Api-Secret-Token header set when the webhook
  // was registered with setWebhook(secret_token=TELEGRAM_WEBHOOK_SECRET).
  const sigCheck = verifyWebhookSignature(req);
  if (!sigCheck.ok) {
    console.warn('[webhook] Rejected request:', sigCheck.reason);
    // Return 200 so Telegram doesn't retry; attackers get no useful signal.
    res.status(200).json({ ok: true });
    return;
  }

  // --- IP rate limiting (secondary defence) ---
  const ip = getClientIp(req);
  if (!await rateLimit(`webhook:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    res.status(200).json({ ok: true }); // Return 200 to Telegram per convention
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const { message } = req.body;

  if (!message || !message.text || !message.chat) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  // Validate chatId is a positive integer before using it.
  if (!Number.isInteger(chatId) || chatId <= 0) {
    res.status(200).json({ ok: true });
    return;
  }

  const text = String(message.text).slice(0, 4096); // enforce Telegram's own limit

  try {
    // 1. Look up user by chatId from Firestore (server-trusted lookup, not from body).
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

    // userId comes from our Firestore lookup — NEVER from the incoming request body.
    const userId = userQuery.docs[0].id;

    // 2. Parse message.
    const parsed = parseTransaction(text);
    if (!parsed) {
      if (text.startsWith('/start')) {
        await sendTelegramMessage(
          token,
          chatId,
          'Привет! Я Enma. Ты можешь записывать расходы прямо здесь.\nПример: "150 кофе" или "+200 кешбэк"'
        );
      }
      res.status(200).json({ ok: true });
      return;
    }

    // 3. Create transaction — userId is always from server-side lookup.
    const transactionId = createId();
    const transaction = {
      id: transactionId,
      userId,               // server-authoritative; never from req.body
      type: parsed.type,
      amount: parsed.amount,
      categoryId: 'cat-default',
      description: parsed.description,
      date: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'telegram-bot'
    };

    await db.collection('transactions').doc(transactionId).set(transaction);

    const typeLabel = parsed.type === 'income' ? 'Доход' : 'Расход';
    await sendTelegramMessage(
      token,
      chatId,
      `✅ Записано: ${typeLabel} ${parsed.amount} — ${parsed.description}`
    );

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};
