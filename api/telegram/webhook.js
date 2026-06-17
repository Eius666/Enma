'use strict';

const { db, getUserCurrency }                      = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }                   = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                   = require('../_lib/rateLimit');
const { checkSubscription }                        = require('../_lib/ai/subscription');
const { routeMessage }                             = require('../_lib/ai/router');
const { buildSystemPrompt }                        = require('../_lib/ai/systemPrompt');
const { markdownToTelegramHtml, splitHtmlMessage } = require('../_lib/ai/markdownToTelegramHtml');
const { parseTransaction }                         = require('../_lib/ai/parseTransaction');
const { saveTransaction }                          = require('../_lib/ai/saveTransaction');

const TELEGRAM_API = 'https://api.telegram.org';

const RATE_LIMIT_MAX       = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

const sendTelegramMessage = async (token, chatId, text) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
};

const APP_URL = process.env.REACT_APP_URL || 'https://enma-silk.vercel.app';

const sendSubscriptionPrompt = async (token, chatId) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Для использования AI-ассистента необходима подписка',
      reply_markup: {
        inline_keyboard: [[{
          text: 'Оформить подписку',
          web_app: { url: `${APP_URL}/#settings` },
        }]],
      },
    }),
  });
};

const sendTelegramHtml = async (token, chatId, htmlText, plainFallback) => {
  const chunks = splitHtmlMessage(htmlText);
  for (const chunk of chunks) {
    const resp = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }),
    });
    if (!resp.ok) {
      // Telegram rejected the HTML markup — fall back to plain text
      await sendTelegramMessage(token, chatId, plainFallback.slice(0, 4096));
      return;
    }
  }
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
    // 1. Look up user by chatId from Firestore
    const userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      await sendTelegramMessage(
        token, chatId,
        '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы мы могли привязать твой аккаунт.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    const userId = userQuery.docs[0].id;

    // 2. Handle /start command
    if (text.startsWith('/start')) {
      await sendTelegramMessage(
        token, chatId,
        'Привет! Я Enma — AI-ассистент для финансов и продуктивности.\n' +
        'Задавай любые вопросы или скажи что хочешь записать — я помогу!\n\n' +
        'Для AI-функций необходима подписка.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    // 3. All messages go through AI (subscription required)
    const { active } = await checkSubscription(userId);
    if (!active) {
      await sendSubscriptionPrompt(token, chatId);
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

      const parsed = parseTransaction(response);
      let displayText = response;

      if (parsed) {
        displayText = parsed.cleanResponse;
        try {
          await saveTransaction(userId, parsed.transaction);
        } catch (saveErr) {
          console.error('[webhook] transaction save failed:', saveErr);
          displayText += '\n\n(не удалось сохранить транзакцию)';
        }
      }

      const htmlText = markdownToTelegramHtml(displayText);
      await sendTelegramHtml(token, chatId, htmlText, displayText);
    } catch (aiErr) {
      console.error('[webhook] AI error:', aiErr);
      await sendTelegramMessage(token, chatId, 'Извините, временно не могу обработать запрос. Попробуйте позже.');
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true });
  }
};
