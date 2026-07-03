'use strict';

const { db, getUserCurrency }                      = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }                   = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                   = require('../_lib/rateLimit');
const { checkSubscription, getTrialUsed, incrementTrialUsed, TRIAL_LIMIT } = require('../_lib/ai/subscription');
const { routeMessageWithTools }                    = require('../_lib/ai/router');
const { TOOL_DEFINITIONS, executeTool }            = require('../_lib/ai/tools');
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

const SUBSCRIPTION_KEYBOARD = (appUrl) => ({
  inline_keyboard: [[{
    text: 'Оформить подписку',
    web_app: { url: `${appUrl}/#settings` },
  }]],
});

// Shown when the user has never started a trial or has an active sub check fail
const sendSubscriptionPrompt = async (token, chatId) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Для использования AI-ассистента необходима подписка.',
      reply_markup: SUBSCRIPTION_KEYBOARD(APP_URL),
    }),
  });
};

// Shown when all trial requests are exhausted
const sendTrialExhaustedPrompt = async (token, chatId) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `У вас закончились пробные запросы (${TRIAL_LIMIT}/${TRIAL_LIMIT}).\nОформите подписку, чтобы продолжить пользоваться AI-ассистентом Enma.`,
      reply_markup: SUBSCRIPTION_KEYBOARD(APP_URL),
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

// Keywords that suggest the user wants to record a transaction.
// Used to let trial-exhausted users still log expenses/income for free.
const TXN_INTENT_RE = /потратил|заплатил|купил|потрачено|расход|трат[ау]|получил|заработал|доход|зарплат|запис[ьи]|запиши|внёс|занёс/i;

function looksLikeTransaction(text) {
  return /\d/.test(text) && TXN_INTENT_RE.test(text);
}

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
        `У тебя есть ${TRIAL_LIMIT} бесплатных пробных запроса. Для неограниченного доступа нужна подписка.`
      );
      res.status(200).json({ ok: true });
      return;
    }

    // 3. Access gate.
    // Transaction recording is always free — check intent BEFORE subscription/trial.
    const isTransactionRequest = looksLikeTransaction(text);

    let usingTrial = false;
    let trialUsed  = 0;

    if (!isTransactionRequest) {
      const { active } = await checkSubscription(userId);
      if (!active) {
        trialUsed = await getTrialUsed(userId);
        if (trialUsed >= TRIAL_LIMIT) {
          await sendTrialExhaustedPrompt(token, chatId);
          res.status(200).json({ ok: true });
          return;
        }
        usingTrial = true;
      }
    }

    const userCurrency = await getUserCurrency(userId);
    const firstName    = message.from?.first_name || '';
    const systemPrompt = buildSystemPrompt({
      currency: userCurrency,
      name: firstName,
      nowIso: new Date().toISOString(),
    });

    // Tool executor closure — binds userId and Telegram chatId for this request
    const execFn = (name, input) => executeTool(name, input, { userId, telegramChatId: chatId });

    try {
      const { response } = await routeMessageWithTools(
        [{ role: 'user', content: text }],
        systemPrompt,
        TOOL_DEFINITIONS,
        execFn
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

      // Transactions are free — only count pure AI replies against the trial.
      // freeTransaction users already exhausted their trial, so never increment them.
      if (usingTrial && !parsed) {
        await incrementTrialUsed(userId);
        const used      = trialUsed + 1;
        const remaining = TRIAL_LIMIT - used;
        if (remaining > 0) {
          await sendTelegramMessage(token, chatId, `💬 Пробный запрос ${used} из ${TRIAL_LIMIT}`);
        } else {
          await sendTrialExhaustedPrompt(token, chatId);
        }
      }
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
