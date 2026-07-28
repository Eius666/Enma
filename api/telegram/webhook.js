'use strict';

const { db, admin, getUserCurrency, getUserTimezone }  = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }                       = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                       = require('../_lib/rateLimit');
const { checkSubscription, getTrialUsed, incrementTrialUsed, TRIAL_LIMIT } = require('../_lib/ai/subscription');
const { routeMessageWithTools }                        = require('../_lib/ai/router');
const { buildSystemPrompt }                            = require('../_lib/ai/systemPrompt');
const { markdownToTelegramHtml, splitHtmlMessage }     = require('../_lib/ai/markdownToTelegramHtml');
const { parseTransaction }                             = require('../_lib/ai/parseTransaction');
const { saveTransaction }                              = require('../_lib/ai/saveTransaction');
const { saveMessage, loadHistory }                     = require('../_lib/ai/chatHistory');
const { handleCallbackQuery, handleAdminTextMessage, isContentCallback, isAdminChatId } = require('../_lib/content/moderationHandler');
const { handleTaskCallback, TOOL_DEFINITIONS, executeTool } = require('../_lib/ai/tools');
const { handleReferralStart, ensureReferralCode }      = require('../_lib/referral/codes');
const { handleReferralCommand, handleWalletCommand, handleBalanceCommand, checkUserState } = require('../_lib/referral/commands');
const { processSubscriptionPayment }                   = require('../_lib/referral/earnings');

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

const sendTelegramHtml = async (token, chatId, htmlText, plainFallback) => {
  const chunks = splitHtmlMessage(htmlText);
  for (const chunk of chunks) {
    const resp = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }),
    });
    if (!resp.ok) {
      await sendTelegramMessage(token, chatId, plainFallback.slice(0, 4096));
      return;
    }
  }
};

const APP_URL = process.env.REACT_APP_URL || 'https://enma-silk.vercel.app';

const SUBSCRIPTION_KEYBOARD = (appUrl) => ({
  inline_keyboard: [[{
    text: 'Оформить подписку',
    web_app: { url: `${appUrl}/#settings` },
  }]],
});

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

const TXN_INTENT_RE = /потратил|заплатил|купил|потрачено|расход|трат[ау]|получил|заработал|доход|зарплат|запис[ьи]|запиши|внёс|занёс/i;
function looksLikeTransaction(text) {
  return /\d/.test(text) && TXN_INTENT_RE.test(text);
}

// ── Stars payment — activate subscription ────────────────────────────────────

async function activateStarsSubscription(token, chatId, userId, payment) {
  const endDate  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const paymentId = payment.telegram_payment_charge_id;

  // Create / extend subscription
  await db.collection('subscriptions').doc(userId).set({
    userId,
    plan:          'pro',
    status:        'active',
    endDate,
    paymentId,
    paymentMethod: 'stars',
    starsAmount:   payment.total_amount,
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Log payment
  await db.collection('payments').add({
    userId,
    paymentId,
    method:    'stars',
    amount:    payment.total_amount,
    currency:  'XTR',
    amountUsd: 10,
    status:    'confirmed',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Process referral commission
  await processSubscriptionPayment(userId, 10, paymentId, token).catch(err =>
    console.error('[WH][stars] referral processing error:', err.message)
  );

  await sendTelegramMessage(token, chatId,
    '🎉 Подписка Enma Pro активирована на 30 дней!\n\nТеперь у тебя безлимит сообщений. Enjoy 🚀'
  );
}

// ── /subscribe command — send Stars invoice ───────────────────────────────────

async function handleSubscribeCommand(token, chatId) {
  const starPrice = parseInt(process.env.STAR_PRICE_MONTHLY, 10) || 1000;

  await fetch(`${TELEGRAM_API}/bot${token}/sendInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:     chatId,
      title:       'Enma Pro — 1 месяц',
      description: 'Безлимит сообщений, AI-ассистент, финансы, напоминания',
      payload:     `enma_sub_${chatId}_${Date.now()}`,
      currency:    'XTR',
      prices:      [{ label: 'Enma Pro · 1 месяц', amount: starPrice }],
    }),
  });
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
  const ip      = getClientIp(req);
  const allowed = await rateLimit(`webhook:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  console.error('[WH][3] rate limit allowed:', allowed, 'ip:', ip);
  if (!allowed) {
    res.status(200).json({ ok: true });
    return;
  }

  // ── [4] PARSE UPDATE ─────────────────────────────────────────────────────────
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;

  // ── [4a] CALLBACK QUERY ───────────────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    console.error('[WH][4a] callback_query from:', cq.from?.id, 'data:', cq.data);

    if (isContentCallback(cq.data)) {
      try { await handleCallbackQuery(token, cq); } catch (err) {
        console.error('[WH][4a] content callback error:', err.message);
      }
    } else if (cq.data?.startsWith('task_')) {
      try { await handleTaskCallback(token, cq); } catch (err) {
        console.error('[WH][4a] task callback error:', err.message);
      }
    } else if (cq.data === 'wallet_set') {
      // "Указать кошелёк" button from /referral
      const chatId = cq.from?.id;
      if (chatId) {
        // Look up user
        const userSnap = await db.collection('users')
          .where('chatId', '==', chatId).limit(1).get()
          .catch(() => ({ empty: true }));
        const userId = userSnap.empty ? null : userSnap.docs[0].id;
        if (userId) {
          const { handleWalletCommand: wc } = require('../_lib/referral/commands');
          await wc(token, chatId, userId).catch(err =>
            console.error('[WH][4a] wallet_set error:', err.message)
          );
        }
        await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        }).catch(() => {});
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── [4b] PRE_CHECKOUT_QUERY (Stars) ──────────────────────────────────────
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    console.error('[WH][4b] pre_checkout_query id:', pcq.id);
    await fetch(`${TELEGRAM_API}/bot${token}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: pcq.id, ok: true }),
    }).catch(err => console.error('[WH][4b] answerPreCheckout error:', err.message));
    res.status(200).json({ ok: true });
    return;
  }

  const { message } = update;

  console.error('[WH][4] update_id:', update?.update_id,
    'has message:', !!message,
    'has text:', !!message?.text,
    'has chat:', !!message?.chat,
    'has successful_payment:', !!message?.successful_payment,
    'other keys:', Object.keys(update || {}).filter(k => k !== 'update_id' && k !== 'message'));

  // ── [4c] SUCCESSFUL PAYMENT (Stars) ──────────────────────────────────────
  if (message?.successful_payment && message?.chat) {
    const chatId = message.chat.id;
    console.error('[WH][4c] successful_payment chatId:', chatId);
    try {
      const userSnap = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
      const userId   = userSnap.empty ? null : userSnap.docs[0].id;
      if (userId) {
        await activateStarsSubscription(token, chatId, userId, message.successful_payment);
      } else {
        console.error('[WH][4c] user not found for chatId:', chatId);
      }
    } catch (err) {
      console.error('[WH][4c] payment activation error:', err.message);
    }
    res.status(200).json({ ok: true });
    return;
  }

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
      req._userId = userQueryStr.docs[0].id;
    }

    const userId = req._userId || userQuery.docs[0].id;
    console.error('[WH][5] userId:', userId);

    // ── [5a] ADMIN CONTENT STATE ──────────────────────────────────────────────
    if (isAdminChatId(chatId)) {
      const handled = await handleAdminTextMessage(token, chatId, text).catch(err => {
        console.error('[WH][5a] admin state error:', err.message);
        return false;
      });
      if (handled) {
        res.status(200).json({ ok: true });
        return;
      }
    }

    // ── [5b] USER STATE MACHINE (wallet setup etc.) ───────────────────────────
    const stateHandled = await checkUserState(token, chatId, userId, text).catch(err => {
      console.error('[WH][5b] user state error:', err.message);
      return false;
    });
    if (stateHandled) {
      res.status(200).json({ ok: true });
      return;
    }

    // ── [6] /start ────────────────────────────────────────────────────────────
    if (text.startsWith('/start')) {
      console.error('[WH][6] /start command');

      // Generate referral code for this user if they don't have one yet
      await ensureReferralCode(userId).catch(err =>
        console.error('[WH][6] ensureReferralCode error:', err.message)
      );

      // Handle referral parameter: /start ref_CODE
      const param = text.split(' ')[1] || '';
      if (param.startsWith('ref_')) {
        const code   = param.slice(4).trim();
        const result = await handleReferralStart(userId, code).catch(err => {
          console.error('[WH][6] handleReferralStart error:', err.message);
          return { ok: false };
        });
        if (result.ok) {
          await sendTelegramMessage(
            token, chatId,
            `👋 Тебя пригласил ${result.referrerName}. Удачи в работе с Enma!\n\n` +
            `У тебя есть ${TRIAL_LIMIT} бесплатных запроса. Для безлимита — /subscribe`
          );
          res.status(200).json({ ok: true });
          return;
        }
      }

      await sendTelegramMessage(
        token, chatId,
        'Привет! Я Enma — AI-ассистент для финансов и продуктивности.\n' +
        'Задавай любые вопросы или скажи что хочешь записать — я помогу!\n\n' +
        `У тебя есть ${TRIAL_LIMIT} бесплатных пробных запроса.\n` +
        'Для безлимита — /subscribe\n' +
        'Реферальная программа — /referral'
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── [6b] BOT COMMANDS ─────────────────────────────────────────────────────

    if (text === '/subscribe' || text.startsWith('/subscribe ')) {
      console.error('[WH][6b] /subscribe');
      await handleSubscribeCommand(token, chatId);
      res.status(200).json({ ok: true });
      return;
    }

    if (text === '/referral' || text.startsWith('/referral ')) {
      console.error('[WH][6b] /referral');
      await handleReferralCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }

    if (text === '/wallet' || text.startsWith('/wallet ')) {
      console.error('[WH][6b] /wallet');
      await handleWalletCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }

    if (text === '/balance' || text.startsWith('/balance ')) {
      console.error('[WH][6b] /balance');
      await handleBalanceCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }

    if (text === '/cancel') {
      console.error('[WH][6b] /cancel');
      await db.collection('user_states').doc(String(chatId)).delete().catch(() => {});
      await sendTelegramMessage(token, chatId, '🚫 Отменено');
      res.status(200).json({ ok: true });
      return;
    }

    // ── [7] ACCESS GATE ───────────────────────────────────────────────────────
    const isTransactionRequest = looksLikeTransaction(text);
    console.error('[WH][7] isTransaction:', isTransactionRequest);

    let usingTrial = false;
    let trialUsed  = 0;
    let subActive  = false;

    if (!isTransactionRequest) {
      const sub = await checkSubscription(userId);
      subActive = sub.active;
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

    // Load conversation history (more for Pro users)
    const history = await loadHistory(userId, subActive).catch(() => []);
    const messages = [...history, { role: 'user', content: text }];

    const execFn = (name, input) => executeTool(name, input, { userId, telegramChatId: chatId, userTimezone });

    // ── [9] AI CALL ───────────────────────────────────────────────────────────
    try {
      console.error('[WH][9] AI call start, history length:', history.length);
      const { response, model } = await routeMessageWithTools(
        messages,
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

      // Save message pair to history
      await Promise.all([
        saveMessage(userId, 'user', text).catch(() => {}),
        saveMessage(userId, 'assistant', displayText).catch(() => {}),
      ]);

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
      const cid = req.body?.message?.chat?.id;
      if (cid && token) {
        await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cid, text: 'Произошла внутренняя ошибка. Попробуй ещё раз через минуту.' }),
        });
      }
    } catch (_) {}
    res.status(200).json({ ok: true });
  }
};
