'use strict';

const { db, getUserCurrency, getUserTimezone }      = require('../_lib/firebaseAdmin');
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
  // ── [1] METHOD ───────────────────────────────────────────────────────────────
  console.error('[WH][1] START method:', req.method, 'body keys:', Object.keys(req.body || {}));

  if (req.method !== 'POST') {
    console.error('[WH][1] ABORT non-POST');
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  // ── [2] SIGNATURE ────────────────────────────────────────────────────────────
  const sigCheck = verifyWebhookSignature(req);
  console.error('[WH][2] sig:', sigCheck.ok, sigCheck.reason || '');
  if (!sigCheck.ok) {
    console.error('[WH][2] ABORT sig failed:', sigCheck.reason);
    res.status(200).json({ ok: true });
    return;
  }

  // ── [3] RATE LIMIT ───────────────────────────────────────────────────────────
  const ip = getClientIp(req);
  const allowed = await rateLimit(`webhook:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  console.error('[WH][3] rate limit allowed:', allowed, 'ip:', ip);
  if (!allowed) {
    res.status(200).json({ ok: true });
    return;
  }

  // ── [4] PARSE UPDATE ─────────────────────────────────────────────────────────
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;
  const { message } = update;

  // Telegram can send many update types (edited_message, channel_post, etc.)
  // Log what we actually received so missing-field silent exits are visible.
  console.error('[WH][4] update_id:', update?.update_id,
    'has message:', !!message,
    'has text:', !!message?.text,
    'has chat:', !!message?.chat,
    'other keys:', Object.keys(update || {}).filter(k => k !== 'update_id' && k !== 'message'));

  if (!message || !message.text || !message.chat) {
    console.error('[WH][4] ABORT no message/text/chat — update type not supported');
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  console.error('[WH][4] chatId:', chatId, 'type:', typeof chatId);
  if (!Number.isInteger(chatId) || chatId <= 0) {
    console.error('[WH][4] ABORT invalid chatId:', chatId);
    res.status(200).json({ ok: true });
    return;
  }

  const text = String(message.text).slice(0, 4096);
  console.error('[WH][4] text:', text.slice(0, 80));

  try {
    // ── [5] USER LOOKUP ───────────────────────────────────────────────────────
    const userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    console.error('[WH][5] user lookup chatId:', chatId, 'found:', !userQuery.empty);

    if (userQuery.empty) {
      // Also try string version — chatId may have been stored as string in Firestore
      const userQueryStr = await db.collection('users').where('chatId', '==', String(chatId)).limit(1).get();
      console.error('[WH][5] user lookup chatId as string:', !userQueryStr.empty);

      if (userQueryStr.empty) {
        console.error('[WH][5] ABORT user not found for chatId:', chatId);
        await sendTelegramMessage(
          token, chatId,
          '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы мы могли привязать твой аккаунт.'
        );
        res.status(200).json({ ok: true });
        return;
      }
      // Found with string chatId — use that doc
      const userId = userQueryStr.docs[0].id;
      console.error('[WH][5] found user via string chatId, userId:', userId);
      req._userId = userId; // pass through for the rest of the handler
    }

    const userId = req._userId || userQuery.docs[0].id;
    console.error('[WH][5] userId:', userId);

    // ── [6] /start ────────────────────────────────────────────────────────────
    if (text.startsWith('/start')) {
      console.error('[WH][6] /start command');
      await sendTelegramMessage(
        token, chatId,
        'Привет! Я Enma — AI-ассистент для финансов и продуктивности.\n' +
        'Задавай любые вопросы или скажи что хочешь записать — я помогу!\n\n' +
        `У тебя есть ${TRIAL_LIMIT} бесплатных пробных запроса. Для неограниченного доступа нужна подписка.`
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── [7] ACCESS GATE ───────────────────────────────────────────────────────
    const isTransactionRequest = looksLikeTransaction(text);
    console.error('[WH][7] isTransaction:', isTransactionRequest);

    let usingTrial = false;
    let trialUsed  = 0;

    if (!isTransactionRequest) {
      const sub = await checkSubscription(userId);
      console.error('[WH][7] subscription:', sub);
      if (!sub.active) {
        trialUsed = await getTrialUsed(userId);
        console.error('[WH][7] trialUsed:', trialUsed, '/', TRIAL_LIMIT);
        if (trialUsed >= TRIAL_LIMIT) {
          console.error('[WH][7] ABORT trial exhausted');
          await sendTrialExhaustedPrompt(token, chatId);
          res.status(200).json({ ok: true });
          return;
        }
        usingTrial = true;
      }
    }

    // ── [8] CONTEXT ───────────────────────────────────────────────────────────
    const [userCurrency, userTimezone] = await Promise.all([
      getUserCurrency(userId),
      getUserTimezone(userId),
    ]);
    console.error('[WH][8] currency:', userCurrency, 'timezone:', userTimezone);

    const firstName    = message.from?.first_name || '';
    const systemPrompt = buildSystemPrompt({
      currency: userCurrency,
      name: firstName,
      nowIso: new Date().toISOString(),
      userTimezone,
    });

    const execFn = (name, input) => executeTool(name, input, { userId, telegramChatId: chatId, userTimezone });

    // ── [9] AI CALL ───────────────────────────────────────────────────────────
    try {
      console.error('[WH][9] AI call start');
      const { response, model } = await routeMessageWithTools(
        [{ role: 'user', content: text }],
        systemPrompt,
        TOOL_DEFINITIONS,
        execFn
      );
      console.error('[WH][9] AI response model:', model, 'length:', response?.length, 'preview:', response?.slice(0, 80));

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

      // ── [10] SEND REPLY ───────────────────────────────────────────────────
      console.error('[WH][10] sending reply to chatId:', chatId, 'html length:', displayText?.length);
      const htmlText = markdownToTelegramHtml(displayText);
      await sendTelegramHtml(token, chatId, htmlText, displayText);
      console.error('[WH][10] reply sent');

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
      console.error('[WH][9] AI error:', aiErr.message, 'status:', aiErr.status);
      await sendTelegramMessage(token, chatId, 'Извините, временно не могу обработать запрос. Попробуйте позже.');
    }

    console.error('[WH] END ok');
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[WH] UNHANDLED ERROR:', error.message, error.stack?.slice(0, 300));
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId && token) {
        await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: 'Произошла внутренняя ошибка. Попробуй ещё раз через минуту.',
          }),
        });
      }
    } catch (_) {}
    res.status(200).json({ ok: true });
  }
};
