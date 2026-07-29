'use strict';

const { db, admin }                                        = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }                           = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                           = require('../_lib/rateLimit');
const { checkSubscription, getTrialUsed, incrementTrialUsed, TRIAL_LIMIT } = require('../_lib/ai/subscription');
const { chatWithTools }                                    = require('../_lib/llm-chat');
const { getUserTimezone, isValidTimezone, getUtcOffsetStr } = require('../_lib/tools');
const { generatePost, generateImage }                      = require('../_lib/content/generator');
const { handleCallbackQuery: handleContentCb, handleAdminTextMessage, isContentCallback, isAdminChatId } = require('../_lib/content/moderationHandler');
const { handleTaskCallback }                               = require('../_lib/ai/tools');
const { handleReferralStart, ensureReferralCode }          = require('../_lib/referral/codes');
const { handleReferralCommand, handleWalletCommand, handleBalanceCommand, checkUserState } = require('../_lib/referral/commands');
const { processSubscriptionPayment }                       = require('../_lib/referral/earnings');
const { saveMessage, loadHistory }                         = require('../_lib/ai/chatHistory');

const TG = 'https://api.telegram.org';

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function tg(token, method, body) {
  const resp = await fetch(`${TG}/bot${token}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return resp.json().catch(() => ({}));
}

const sendMessage = (token, chatId, text, opts = {}) =>
  tg(token, 'sendMessage', { chat_id: chatId, text, ...opts });

const editMessage = (token, chatId, messageId, text, opts = {}) =>
  tg(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });

const sendPhoto = (token, chatId, photo, caption, opts = {}) =>
  tg(token, 'sendPhoto', { chat_id: chatId, photo, caption, ...opts });

const sendChatAction = (token, chatId, action = 'typing') =>
  tg(token, 'sendChatAction', { chat_id: chatId, action });

const answerCbQuery = (token, id, text) =>
  tg(token, 'answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});

// ── Subscription prompt helpers ───────────────────────────────────────────────

const APP_URL = process.env.REACT_APP_URL || 'https://enma-silk.vercel.app';

const subscriptionKeyboard = () => ({
  inline_keyboard: [[{ text: 'Оформить подписку', web_app: { url: `${APP_URL}/#settings` } }]],
});

const sendSubscriptionPrompt = (token, chatId) =>
  sendMessage(token, chatId, 'Для использования AI-ассистента необходима подписка.', {
    reply_markup: subscriptionKeyboard(),
  });

const sendTrialExhaustedPrompt = (token, chatId) =>
  sendMessage(token, chatId,
    `У вас закончились пробные запросы (${TRIAL_LIMIT}/${TRIAL_LIMIT}).\n` +
    'Оформите подписку, чтобы продолжить пользоваться Enma.',
    { reply_markup: subscriptionKeyboard() }
  );

// ── /subscribe — Telegram Stars invoice ───────────────────────────────────────

async function handleSubscribeCommand(token, chatId) {
  const starPrice = parseInt(process.env.STAR_PRICE_MONTHLY, 10) || 1000;
  await tg(token, 'sendInvoice', {
    chat_id:     chatId,
    title:       'Enma Pro — 1 месяц',
    description: 'Безлимит сообщений, AI-ассистент, финансы, напоминания',
    payload:     `enma_sub_${chatId}_${Date.now()}`,
    currency:    'XTR',
    prices:      [{ label: 'Enma Pro · 1 месяц', amount: starPrice }],
  });
}

// ── Stars payment activation ──────────────────────────────────────────────────

async function activateStarsSubscription(token, chatId, userId, payment) {
  const endDate  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const paymentId = payment.telegram_payment_charge_id;

  await db.collection('subscriptions').doc(userId).set({
    userId, plan: 'pro', status: 'active', endDate, paymentId,
    paymentMethod: 'stars', starsAmount: payment.total_amount,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('payments').add({
    userId, paymentId, method: 'stars',
    amount: payment.total_amount, currency: 'XTR', amountUsd: 10,
    status: 'confirmed', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await processSubscriptionPayment(userId, 10, paymentId, token).catch(err =>
    console.error('[WH][stars] referral error:', err.message)
  );

  await sendMessage(token, chatId,
    '🎉 Подписка Enma Pro активирована на 30 дней!\n\nТеперь у тебя безлимит. Enjoy 🚀'
  );
}

// ── Content generation (/generate, /post commands) ───────────────────────────

function getNextPublishSlot() {
  const SLOTS = [8, 10, 13];
  const now   = new Date();
  const h     = now.getUTCHours();
  const base  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (const slot of SLOTS) {
    if (slot > h) { base.setUTCHours(slot, 0, 0, 0); return base; }
  }
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(SLOTS[0], 0, 0, 0);
  return base;
}

const generateKeyboard = (docId) => ({
  inline_keyboard: [[
    { text: '✅ Одобрить',        callback_data: `gen:approve:${docId}` },
    { text: '❌ Отклонить',       callback_data: `gen:reject:${docId}` },
    { text: '🔄 Перегенерировать', callback_data: `gen:regenerate:${docId}` },
  ]],
});

async function handleContentGeneration(docId, chatId, token) {
  const docRef = db.collection('content_queue').doc(docId);

  // Show spinner
  const spinnerMsg = await sendMessage(token, chatId, '⏳ Генерирую пост…');
  const spinnerId  = spinnerMsg?.result?.message_id;

  try {
    // Stage 1: text (8s timeout)
    const postData = await generatePost({ title: 'Новый пост', angle: 'Автогенерация' }, 8_000);

    await docRef.update({
      text:         postData.threadsText  || '',
      telegramText: postData.telegramText || postData.threadsText || '',
      imagePrompt:  postData.imagePrompt  || '',
      status:       'draft',
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    const preview = postData.telegramText || postData.threadsText || '(нет текста)';

    // Stage 2: image (14s timeout, non-blocking)
    let imageUrl = null;
    if (postData.imagePrompt) {
      try {
        imageUrl = await generateImage(postData.imagePrompt, 14_000);
        if (imageUrl) {
          await docRef.update({ imageUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      } catch (imgErr) {
        console.error('[WH][gen] image failed:', imgErr.message);
      }
    }

    // Send preview
    if (spinnerId) {
      await tg(token, 'deleteMessage', { chat_id: chatId, message_id: spinnerId }).catch(() => {});
    }

    const keyboard = generateKeyboard(docId);

    if (imageUrl) {
      await sendPhoto(token, chatId, imageUrl, preview.slice(0, 1024), { reply_markup: keyboard });
    } else {
      await sendMessage(token, chatId, `📝 Превью поста:\n\n${preview}`, { reply_markup: keyboard });
    }
  } catch (err) {
    console.error('[WH][gen] generation failed:', err.message);
    if (spinnerId) {
      await editMessage(token, chatId, spinnerId, `❌ Ошибка генерации: ${err.message}`).catch(() => {});
    }
    await docRef.update({ status: 'failed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

// Callback handler for gen:action:docId callbacks
async function handleGenerateCallback(token, cq) {
  const [, action, docId] = cq.data.split(':');
  const chatId = cq.message?.chat?.id;

  if (!docId || !chatId) { await answerCbQuery(token, cq.id); return; }

  const docRef = db.collection('content_queue').doc(docId);

  if (action === 'approve') {
    const scheduledAt = getNextPublishSlot();
    await docRef.update({
      status:      'approved',
      scheduledAt: admin.firestore.Timestamp.fromDate(scheduledAt),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    const msk = scheduledAt.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
      day: 'numeric', month: 'short',
    });
    await answerCbQuery(token, cq.id, `✅ Одобрено — публикация в ${msk} МСК`);
    await tg(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await sendMessage(token, chatId, `✅ Пост одобрен! Публикация в ${msk} (МСК).`);

  } else if (action === 'reject') {
    await docRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await answerCbQuery(token, cq.id, '❌ Пост отклонён');
    await tg(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await sendMessage(token, chatId, '❌ Пост отклонён.');

  } else if (action === 'regenerate') {
    await answerCbQuery(token, cq.id, '🔄 Перегенерирую…');
    await handleContentGeneration(docId, chatId, token);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // [1] POST only
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false });
    return;
  }

  // [2] Signature
  const sigCheck = verifyWebhookSignature(req);
  if (!sigCheck.ok) { res.status(200).json({ ok: true }); return; }

  // [3] Rate limit
  const ip      = getClientIp(req);
  const allowed = await rateLimit(`webhook:${ip}`, 100, 60_000);
  if (!allowed) { res.status(200).json({ ok: true }); return; }

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const update = req.body;

  try {
    // ── [4a] CALLBACK QUERY ──────────────────────────────────────────────────
    if (update.callback_query) {
      const cq   = update.callback_query;
      const data = cq.data || '';

      if (data.startsWith('gen:')) {
        await handleGenerateCallback(token, cq).catch(err =>
          console.error('[WH][4a] gen callback error:', err.message)
        );
      } else if (isContentCallback(data)) {
        await handleContentCb(token, cq).catch(err =>
          console.error('[WH][4a] content callback error:', err.message)
        );
      } else if (data.startsWith('task_')) {
        await handleTaskCallback(token, cq).catch(err =>
          console.error('[WH][4a] task callback error:', err.message)
        );
      } else if (data === 'wallet_set') {
        const chatId = cq.from?.id;
        if (chatId) {
          const snap = await db.collection('users').where('chatId', '==', chatId).limit(1).get().catch(() => ({ empty: true }));
          const userId = snap.empty ? null : snap.docs[0].id;
          if (userId) await handleWalletCommand(token, chatId, userId).catch(() => {});
          await answerCbQuery(token, cq.id);
        }
      } else {
        await answerCbQuery(token, cq.id);
      }

      res.status(200).json({ ok: true });
      return;
    }

    // ── [4b] PRE_CHECKOUT_QUERY ──────────────────────────────────────────────
    if (update.pre_checkout_query) {
      await tg(token, 'answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id, ok: true,
      });
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;

    // ── [4c] SUCCESSFUL PAYMENT ──────────────────────────────────────────────
    if (message?.successful_payment && message?.chat) {
      const chatId = message.chat.id;
      const snap   = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
      const userId = snap.empty ? null : snap.docs[0].id;
      if (userId) {
        await activateStarsSubscription(token, chatId, userId, message.successful_payment);
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (!message?.text || !message?.chat) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const text   = String(message.text).slice(0, 4096);

    // ── [5] USER LOOKUP ──────────────────────────────────────────────────────
    let userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      userQuery = await db.collection('users').where('chatId', '==', String(chatId)).limit(1).get();
    }
    if (userQuery.empty) {
      await sendMessage(token, chatId,
        '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы привязать аккаунт.'
      );
      res.status(200).json({ ok: true });
      return;
    }
    const userId = userQuery.docs[0].id;

    // ── [5a] ADMIN CONTENT STATE ─────────────────────────────────────────────
    if (isAdminChatId(chatId)) {
      const handled = await handleAdminTextMessage(token, chatId, text).catch(() => false);
      if (handled) { res.status(200).json({ ok: true }); return; }
    }

    // ── [5b] USER STATE MACHINE (wallet setup) ───────────────────────────────
    const stateHandled = await checkUserState(token, chatId, userId, text).catch(() => false);
    if (stateHandled) { res.status(200).json({ ok: true }); return; }

    // ── [6] /start ───────────────────────────────────────────────────────────
    if (text.startsWith('/start')) {
      await ensureReferralCode(userId).catch(() => {});
      const param = text.split(' ')[1] || '';
      if (param.startsWith('ref_')) {
        const result = await handleReferralStart(userId, param.slice(4)).catch(() => ({ ok: false }));
        if (result.ok) {
          await sendMessage(token, chatId,
            `👋 Тебя пригласил ${result.referrerName}.\n\n` +
            `У тебя ${TRIAL_LIMIT} бесплатных запроса. Для безлимита — /subscribe`
          );
          res.status(200).json({ ok: true });
          return;
        }
      }
      await sendMessage(token, chatId,
        'Привет! Я Enma — AI-ассистент для финансов и продуктивности.\n\n' +
        'Что умею:\n' +
        '💬 Отвечать на вопросы\n' +
        '🔍 Искать в интернете (погода, курсы, новости)\n' +
        '⏰ Создавать напоминания\n' +
        '📋 Вести задачи\n' +
        '💰 Записывать расходы и доходы\n\n' +
        `У тебя ${TRIAL_LIMIT} бесплатных запроса.\n` +
        'Подписка — /subscribe\n' +
        'Реферальная программа — /referral'
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── [6b] COMMANDS ────────────────────────────────────────────────────────
    if (text === '/subscribe' || text.startsWith('/subscribe ')) {
      await handleSubscribeCommand(token, chatId);
      res.status(200).json({ ok: true });
      return;
    }
    if (text === '/referral' || text.startsWith('/referral ')) {
      await handleReferralCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }
    if (text === '/wallet' || text.startsWith('/wallet ')) {
      await handleWalletCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }
    if (text === '/balance' || text.startsWith('/balance ')) {
      await handleBalanceCommand(token, chatId, userId);
      res.status(200).json({ ok: true });
      return;
    }
    if (text === '/cancel') {
      await db.collection('user_states').doc(String(chatId)).delete().catch(() => {});
      await sendMessage(token, chatId, '🚫 Отменено');
      res.status(200).json({ ok: true });
      return;
    }

    if (text === '/timezone' || text.startsWith('/timezone ')) {
      const arg = text.slice('/timezone'.length).trim();
      if (!arg) {
        const tz     = await getUserTimezone(userId);
        const offset = getUtcOffsetStr(tz);
        await sendMessage(token, chatId, `Твой часовой пояс: ${tz} (${offset})\n\nЧтобы изменить: /timezone Europe/Warsaw`);
      } else if (!isValidTimezone(arg)) {
        await sendMessage(token, chatId, `❌ Неверный часовой пояс: «${arg}»\nПример: /timezone Europe/Warsaw`);
      } else {
        await db.collection('users').doc(userId).update({ timezone: arg });
        const offset = getUtcOffsetStr(arg);
        await sendMessage(token, chatId, `✅ Часовой пояс обновлён: ${arg} (${offset})`);
      }
      res.status(200).json({ ok: true });
      return;
    }

    // /generate or /post — content generation (admin only)
    if (text === '/generate' || text === '/post' || text.startsWith('/generate ') || text.startsWith('/post ')) {
      if (!isAdminChatId(chatId)) {
        await sendMessage(token, chatId, '⛔ Только для администраторов.');
        res.status(200).json({ ok: true });
        return;
      }
      const docRef = db.collection('content_queue').doc();
      await docRef.set({
        status:    'generating',
        chatId,
        userId,
        source:    'telegram-command',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Fire and don't await — generation is async (up to 22s total)
      handleContentGeneration(docRef.id, chatId, token).catch(err =>
        console.error('[WH][gen] unhandled:', err.message)
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── [7] ACCESS GATE ──────────────────────────────────────────────────────
    const sub = await checkSubscription(userId);
    let usingTrial = false;
    let trialUsed  = 0;

    if (!sub.active) {
      trialUsed = await getTrialUsed(userId);
      if (trialUsed >= TRIAL_LIMIT) {
        await sendTrialExhaustedPrompt(token, chatId);
        res.status(200).json({ ok: true });
        return;
      }
      usingTrial = true;
    }

    // ── [8] CHAT WITH TOOLS ──────────────────────────────────────────────────
    await sendChatAction(token, chatId);

    const history = await loadHistory(userId, sub.active).catch(() => []);

    let replyText;
    try {
      const { text: response } = await chatWithTools(text, userId, chatId, history);
      replyText = response || 'Не удалось получить ответ.';
    } catch (aiErr) {
      console.error('[WH][8] chatWithTools error:', aiErr.message);
      replyText = 'Извините, временно не могу обработать запрос. Попробуйте позже.';
    }

    await sendMessage(token, chatId, replyText, { disable_web_page_preview: true });

    await Promise.all([
      saveMessage(userId, 'user', text).catch(() => {}),
      saveMessage(userId, 'assistant', replyText).catch(() => {}),
    ]);

    if (usingTrial) {
      await incrementTrialUsed(userId);
      const used      = trialUsed + 1;
      const remaining = TRIAL_LIMIT - used;
      if (remaining > 0) {
        await sendMessage(token, chatId, `💬 Пробный запрос ${used} из ${TRIAL_LIMIT}`);
      } else {
        await sendTrialExhaustedPrompt(token, chatId);
      }
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[WH] UNHANDLED:', err.message);
    try {
      const cid = req.body?.message?.chat?.id;
      if (cid && token) {
        await sendMessage(token, cid, 'Произошла внутренняя ошибка. Попробуй через минуту.');
      }
    } catch (_) {}
    res.status(200).json({ ok: true });
  }
};
