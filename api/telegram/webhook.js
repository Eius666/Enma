'use strict';

const { db, admin }                                        = require('../_lib/firebaseAdmin');
const { verifyWebhookSignature }                           = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                           = require('../_lib/rateLimit');
const { checkSubscription, getTrialUsed, incrementTrialUsed, TRIAL_LIMIT } = require('../_lib/ai/subscription');
const { chatWithTools }                                    = require('../_lib/llm-chat');
const { executeTool, getUserTimezone, getUserCurrency, isValidTimezone, getUtcOffsetStr } = require('../_lib/tools');
const { generatePost, generateImage }                      = require('../_lib/content/generator');
const { handleCallbackQuery: handleContentCb, handleAdminTextMessage, isContentCallback, isAdminChatId } = require('../_lib/content/moderationHandler');
const { handleTaskCallback }                               = require('../_lib/ai/tools');
const { handleReferralStart, ensureReferralCode }          = require('../_lib/referral/codes');
const { handleReferralCommand, handleWalletCommand, handleBalanceCommand, checkUserState } = require('../_lib/referral/commands');
const { processSubscriptionPayment }                       = require('../_lib/referral/earnings');
const { saveMessage, loadHistory }                         = require('../_lib/ai/chatHistory');
const { createSbpPayment, BASE_PRICE }                     = require('../_lib/platega');
const { validatePromoCode, applyPromoToUser, getUserPromo } = require('../_lib/promoCodes');

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
  tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });

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

// ── Vision — analyse a Telegram photo ────────────────────────────────────────

async function handlePhotoMessage(token, chatId, photos, caption) {
  const apiKey      = process.env.OPENROUTER_API_KEY;
  const visionModel = process.env.VISION_MODEL || 'google/gemini-2.5-flash';

  // Telegram gives multiple sizes; pick the largest
  const photo    = photos[photos.length - 1];
  const fileRes  = await fetch(`${TG}/bot${token}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json();
  const filePath = fileData.result?.file_path;

  if (!filePath) return null;

  const imgResp   = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`,
    { signal: AbortSignal.timeout(15_000) });
  const imgBuf    = await imgResp.arrayBuffer();
  const base64    = Buffer.from(imgBuf).toString('base64');
  const mime      = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const userPrompt = caption
    ? `Пользователь отправил фото с подписью: "${caption}". Опиши что на изображении и ответь на вопрос или контекст из подписи.`
    : 'Опиши что на этом изображении. Отвечай на русском, будь кратким и точным.';

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer':  'https://enma.app',
      'X-Title':       'Enma',
    },
    body: JSON.stringify({
      model:      visionModel,
      max_tokens: 600,
      messages: [{
        role:    'user',
        content: [
          { type: 'text',      text: userPrompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    console.error('[WH][vision] API error:', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
    return null;
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

// ── Voice — transcribe with Whisper (no disk writes) ─────────────────────────

async function handleVoiceMessage(token, voice) {
  const openaiKey    = process.env.OPENAI_API_KEY;
  const whisperModel = process.env.WHISPER_MODEL || 'whisper-1';

  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  // 1. Get Telegram file path
  const fileRes  = await fetch(`${TG}/bot${token}/getFile?file_id=${voice.file_id}`);
  const fileData = await fileRes.json();
  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error('Telegram getFile: no file_path');

  // 2. Download audio into memory (Vercel is read-only — no fs writes)
  const audioResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`,
    { signal: AbortSignal.timeout(20_000) });
  if (!audioResp.ok) throw new Error(`Telegram download ${audioResp.status}`);

  const audioBuf = await audioResp.arrayBuffer();

  // 3. Send to Whisper via in-memory FormData + Blob
  const form = new FormData();
  form.append('file',     new Blob([audioBuf], { type: 'audio/ogg' }), 'audio.ogg');
  form.append('model',    whisperModel);
  form.append('language', 'ru');

  const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}` },
    body:    form,
    signal:  AbortSignal.timeout(30_000),
  });

  if (!whisperResp.ok) {
    const errText = await whisperResp.text().catch(() => '');
    console.error('[WH][voice] Whisper error:', whisperResp.status, errText.slice(0, 200));
    throw new Error(`Whisper ${whisperResp.status}`);
  }

  const result = await whisperResp.json();
  console.log('[WH][voice] transcribed', (result.text || '').length, 'chars');
  return result.text?.trim() || null;
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
      } else if (data === 'sbp_pay') {
        const cbChatId = cq.from?.id;
        if (cbChatId) {
          try {
            const cbSnap   = await db.collection('users').where('chatId', '==', cbChatId).limit(1).get().catch(() => ({ empty: true }));
            const cbUserId = cbSnap.empty ? null : cbSnap.docs[0].id;
            if (cbUserId) {
              const userName  = cq.from?.username ? `@${cq.from.username}` : '';
              const promo     = await getUserPromo(cbUserId).catch(() => null);
              const discount  = promo ? promo.discountPercent : 0;
              const finalAmount = promo ? Math.round(BASE_PRICE * (1 - discount / 100)) : BASE_PRICE;
              const { url, expiresIn } = await createSbpPayment({
                userId:          cbUserId,
                finalAmount,
                userName,
                originalAmount:  BASE_PRICE,
                discountPercent: discount,
                promoCode:       promo ? promo.code : null,
              });
              await answerCbQuery(token, cq.id);
              await sendMessage(token, cbChatId,
                `💳 Платёж на <b>${finalAmount} ₽</b> через СБП\n\nСсылка действительна ${expiresIn || '15 минут'}.`,
                { reply_markup: { inline_keyboard: [[{ text: '🏦 Оплатить через СБП', url }]] } }
              );
            } else {
              await answerCbQuery(token, cq.id, '❌ Аккаунт не найден');
            }
          } catch (err) {
            console.error('[pay] sbp error:', err.message);
            await answerCbQuery(token, cq.id, '❌ Ошибка создания платежа');
          }
        }
      } else if (data === 'delete_confirm') {
        const cbChatId = cq.from?.id;
        if (cbChatId) {
          const snap = await db.collection('users').where('chatId', '==', cbChatId).limit(1).get().catch(() => ({ empty: true }));
          if (!snap.empty) {
            const cbUserId = snap.docs[0].id;
            const batch = db.batch();
            const txSnap = await db.collection('transactions').where('userId', '==', cbUserId).limit(500).get().catch(() => ({ empty: true }));
            if (!txSnap.empty) txSnap.docs.forEach(d => batch.delete(d.ref));
            const goalSnap = await db.collection('goals').where('userId', '==', cbUserId).limit(100).get().catch(() => ({ empty: true }));
            if (!goalSnap.empty) goalSnap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit().catch(() => {});
          }
          await answerCbQuery(token, cq.id, 'Данные удалены');
          await tg(token, 'editMessageText', {
            chat_id: cbChatId, message_id: cq.message?.message_id,
            text: '🗑 Все транзакции и цели удалены.',
          }).catch(() => {});
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

    const text   = message?.text         ? String(message.text).slice(0, 4096) : null;
    const photos = message?.photo?.length ? message.photo                       : null;
    const voice  = message?.voice        ? message.voice                        : null;

    if (!message?.chat || (!text && !photos && !voice)) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;

    // ── [5] USER LOOKUP ──────────────────────────────────────────────────────
    let userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      userQuery = await db.collection('users').where('chatId', '==', String(chatId)).limit(1).get();
    }
    if (userQuery.empty) {
      if (text?.startsWith('/start')) {
        await sendMessage(token, chatId,
          'Привет! Я Enma — AI-ассистент для финансов и продуктивности.\n\n' +
          'Чтобы начать, открой веб-приложение и создай аккаунт:\n' +
          `👉 ${APP_URL}\n\n` +
          'После регистрации вернись сюда — я готов к работе! 🚀'
        );
      } else {
        await sendMessage(token, chatId,
          `⚠️ Сначала открой Enma и создай аккаунт:\n👉 ${APP_URL}\n\nПосле этого вернись сюда.`
        );
      }
      res.status(200).json({ ok: true });
      return;
    }
    const userId = userQuery.docs[0].id;

    // ── [5a–6b] TEXT-ONLY FLOWS ──────────────────────────────────────────────
    if (text) {
      if (isAdminChatId(chatId)) {
        const handled = await handleAdminTextMessage(token, chatId, text).catch(() => false);
        if (handled) { res.status(200).json({ ok: true }); return; }
      }

      const stateHandled = await checkUserState(token, chatId, userId, text).catch(() => false);
      if (stateHandled) { res.status(200).json({ ok: true }); return; }

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
            res.status(200).json({ ok: true }); return;
          }
        }
        await sendMessage(token, chatId,
          'Привет! Я Энма 👋\n\n' +
          'Помогу с финансами, задачами и напоминаниями. Просто пиши как другу.\n\n' +
          'Попробуй:\n' +
          '— «потратила 800 на продукты»\n' +
          '— «напомни завтра в 9 утра про встречу»\n' +
          '— «сколько потратила за месяц?»\n\n' +
          `Пробных запросов: ${TRIAL_LIMIT}. Безлимит — /subscribe\n` +
          'Все команды — /help'
        );
        res.status(200).json({ ok: true }); return;
      }

      if (text === '/pay' || text === '/оплата') {
        const promo = await getUserPromo(userId).catch(() => null);
        const finalAmount = promo
          ? Math.round(BASE_PRICE * (1 - promo.discountPercent / 100))
          : BASE_PRICE;
        const btnLabel = promo
          ? `Оплатить ${finalAmount} ₽/мес (скидка ${promo.discountPercent}%)`
          : `Оплатить ${BASE_PRICE} ₽/мес`;
        await sendMessage(token, chatId,
          '💳 <b>Enma Pro — 30 дней</b>\n\nАктивирует безлимитный доступ к AI-ассистенту.',
          { reply_markup: { inline_keyboard: [[{ text: btnLabel, callback_data: 'sbp_pay' }]] } }
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text.startsWith('/promo ') || text.startsWith('/промокод ')) {
        const parts = text.split(' ');
        const code  = parts[1]?.trim();
        if (!code) {
          await sendMessage(token, chatId, '❓ Укажи код: /promo ENMATECH90');
          res.status(200).json({ ok: true }); return;
        }
        const result = await validatePromoCode(code).catch(() => ({ valid: false, error: 'error' }));
        if (result.valid) {
          await applyPromoToUser(userId, result.code);
          const finalAmount = Math.round(BASE_PRICE * (1 - result.discountPercent / 100));
          await sendMessage(token, chatId,
            `🎉 Промокод <b>${result.code}</b> активирован!\n\n` +
            `Скидка ${result.discountPercent}%. Оплати подписку за <b>${finalAmount} ₽</b> вместо ${BASE_PRICE} ₽ 💸\n\n` +
            `Жми /pay для оплаты`
          );
        } else {
          await sendMessage(token, chatId, '❌ Промокод не найден или больше не действует');
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/status' || text === '/подписка') {
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        const sub = userData.subscription;
        const isPro = userData.isPro && sub?.status === 'active' && sub?.endDate;
        if (isPro) {
          const endDate = new Date(sub.endDate);
          if (endDate > new Date()) {
            const daysLeft = Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24));
            const dateStr = endDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            const planLabel = sub.plan === 'premium' ? 'Premium' : 'Pro';
            await sendMessage(token, chatId,
              `✨ <b>Enma ${planLabel}</b> активна\n\nДо: <b>${dateStr}</b>\nОсталось: <b>${daysLeft} дн.</b>`
            );
          } else {
            await sendMessage(token, chatId, '⏰ Подписка истекла. Оформи новую: /pay');
          }
        } else {
          const trialUsed = await getTrialUsed(userId).catch(() => 0);
          const remaining = Math.max(0, TRIAL_LIMIT - trialUsed);
          await sendMessage(token, chatId,
            `🔓 Подписка не активна\n\nПробных запросов: <b>${remaining} из ${TRIAL_LIMIT}</b>\n\nОформить Pro: /pay`
          );
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/subscribe' || text.startsWith('/subscribe ')) {
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        const sub = userData.subscription;
        const isPro = userData.isPro && sub?.status === 'active' && sub?.endDate;
        if (isPro) {
          const endDate = new Date(sub.endDate);
          if (endDate > new Date()) {
            const dateStr = endDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            await sendMessage(token, chatId,
              `✨ Подписка уже активна до <b>${dateStr}</b>\n\nПродлить заранее: /pay`
            );
            res.status(200).json({ ok: true }); return;
          }
        }
        const promo = await getUserPromo(userId).catch(() => null);
        const finalAmount = promo
          ? Math.round(BASE_PRICE * (1 - promo.discountPercent / 100))
          : BASE_PRICE;
        const btnLabel = promo
          ? `Оплатить ${finalAmount} ₽/мес (скидка ${promo.discountPercent}%)`
          : `Оплатить ${BASE_PRICE} ₽/мес`;
        await sendMessage(token, chatId,
          '💳 <b>Enma Pro — 30 дней</b>\n\nAI-ассистент, финансы, напоминания без ограничений.',
          { reply_markup: { inline_keyboard: [[{ text: btnLabel, callback_data: 'sbp_pay' }]] } }
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/referral' || text.startsWith('/referral ')) {
        await handleReferralCommand(token, chatId, userId);
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/wallet' || text.startsWith('/wallet ')) {
        await handleWalletCommand(token, chatId, userId);
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/balance' || text.startsWith('/balance ')) {
        await handleBalanceCommand(token, chatId, userId);
        res.status(200).json({ ok: true }); return;
      }
      if (text.toLowerCase() === 'plat chek') {
        await sendMessage(token, chatId, 'Правовая информация', {
          reply_markup: {
            inline_keyboard: [[
              { text: '📄 Политика конфиденциальности', url: `${APP_URL}/privacy.html` },
              { text: '📝 Пользовательское соглашение',  url: `${APP_URL}/terms.html`   },
            ]],
          },
        });
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/cancel') {
        await db.collection('user_states').doc(String(chatId)).delete().catch(() => {});
        await sendMessage(token, chatId, '🚫 Отменено');
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/support' || text === '/поддержка') {
        await sendMessage(token, chatId,
          '📧 <b>Служба поддержки</b>\n\nДля обращения в службу поддержки напишите нам на почту:\n\n<code>EnmatechTest@outlook.com</code>'
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/privacy' || text === '/политика') {
        await sendMessage(token, chatId,
          `📄 <b>Политика конфиденциальности</b>\n\n${APP_URL}/privacy.html`,
          { reply_markup: { inline_keyboard: [[{ text: '📄 Открыть', url: `${APP_URL}/privacy.html` }]] } }
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/terms' || text === '/соглашение') {
        await sendMessage(token, chatId,
          `📋 <b>Пользовательское соглашение</b>\n\n${APP_URL}/terms.html`,
          { reply_markup: { inline_keyboard: [[{ text: '📋 Открыть', url: `${APP_URL}/terms.html` }]] } }
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/help' || text === '/помощь') {
        await sendMessage(token, chatId,
          '<b>Команды:</b>\n\n' +
          '/stats — траты за месяц\n' +
          '/banks — мои банки и методы оплаты\n' +
          '/goals — цели накопления\n' +
          '/export — выгрузить последние транзакции\n\n' +
          '/status — статус подписки\n' +
          '/pay — оплата через СБП (1000 ₽/мес)\n' +
          '/promo — активировать промокод\n' +
          '/subscribe — подписка через Telegram Stars\n' +
          '/referral — пригласить друга и получить бонус\n' +
          '/balance — баланс реферальных бонусов\n' +
          '/wallet — TON-кошелёк\n\n' +
          '/timezone — изменить часовой пояс\n' +
          '/delete — удалить мои данные\n' +
          '/cancel — отменить текущее действие\n\n' +
          '📄 /privacy · 📋 /terms · 📧 /support'
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/stats' || text === '/статистика') {
        const [tz, cur] = await Promise.all([
          getUserTimezone(userId).catch(() => 'Europe/Warsaw'),
          getUserCurrency(userId).catch(() => 'RUB'),
        ]);
        const result = await executeTool('get_finance_stats', { period: 'month' }, userId, chatId, tz, cur)
          .catch(err => ({ ok: false, error: err.message }));
        if (!result.ok) {
          await sendMessage(token, chatId, '📊 Не удалось загрузить статистику. Попробуй чуть позже.');
        } else {
          const sym  = { USD: '$', EUR: '€', RUB: '₽', BYN: 'Br', CNY: '¥' }[cur] || cur;
          const inc  = result.income  ?? 0;
          const exp  = result.expenses ?? 0;
          const bal  = inc - exp;
          const sign = bal >= 0 ? '+' : '';
          let msg = `📊 <b>Этот месяц</b>\n\n` +
            `Доходы: <b>${inc} ${sym}</b>\n` +
            `Расходы: <b>${exp} ${sym}</b>\n` +
            `Баланс: <b>${sign}${bal} ${sym}</b>`;
          if (result.byCategory && Object.keys(result.byCategory).length) {
            const cats = Object.entries(result.byCategory)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([cat, amt]) => `  ${cat}: ${amt} ${sym}`)
              .join('\n');
            msg += `\n\n<b>Топ категорий:</b>\n${cats}`;
          }
          await sendMessage(token, chatId, msg);
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/export') {
        const cur = await getUserCurrency(userId).catch(() => 'RUB');
        const sym = { USD: '$', EUR: '€', RUB: '₽', BYN: 'Br', CNY: '¥' }[cur] || cur;
        const txSnap = await db.collection('transactions')
          .where('userId', '==', userId)
          .orderBy('date', 'desc')
          .limit(30)
          .get()
          .catch(() => ({ empty: true }));
        if (txSnap.empty) {
          await sendMessage(token, chatId, 'Транзакций пока нет 🤷');
        } else {
          const lines = txSnap.docs.map(d => {
            const t    = d.data();
            const sign = t.type === 'income' ? '+' : '−';
            const date = t.date ? new Date(t.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '?';
            const cat  = t.category || t.categoryId || '';
            const bank = t.bank ? ` · ${t.bank}` : '';
            const desc = t.description || cat || '—';
            return `${date} ${sign}${t.amount} ${sym}  ${desc}${bank}`;
          });
          await sendMessage(token, chatId,
            `<b>Последние ${lines.length} транзакций:</b>\n\n<code>${lines.join('\n')}</code>`
          );
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/delete' || text === '/удалить') {
        await sendMessage(token, chatId,
          '⚠️ <b>Удаление данных</b>\n\n' +
          'Это удалит все твои транзакции и цели накопления. Отменить нельзя.\n\n' +
          'Настройки аккаунта (язык, валюта, банки) останутся.',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🗑 Да, удалить', callback_data: 'delete_confirm' },
                { text: '↩️ Отмена',     callback_data: 'noop'           },
              ]],
            },
          }
        );
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/timezone' || text.startsWith('/timezone ')) {
        const arg = text.slice('/timezone'.length).trim();
        if (!arg) {
          const tz     = await getUserTimezone(userId);
          const offset = getUtcOffsetStr(tz);
          await sendMessage(token, chatId, `Часовой пояс: ${tz} (${offset})\n\nИзменить: /timezone Europe/Warsaw`);
        } else if (!isValidTimezone(arg)) {
          await sendMessage(token, chatId, `❌ Неверный часовой пояс: «${arg}»\nПример: /timezone Europe/Warsaw`);
        } else {
          await db.collection('users').doc(userId).update({ timezone: arg });
          await sendMessage(token, chatId, `✅ Часовой пояс обновлён: ${arg} (${getUtcOffsetStr(arg)})`);
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/banks') {
        const userDoc = await db.collection('users').doc(userId).get();
        const banks   = userDoc.exists ? (userDoc.data()?.banks || []) : [];
        if (!banks.length) {
          await sendMessage(token, chatId,
            'Банков пока нет 🏦\n\nДобавь: «Мои банки: Тинькофф, Сбербанк, Наличные»'
          );
        } else {
          await sendMessage(token, chatId,
            `🏦 <b>Твои банки:</b>\n${banks.map(b => `• ${b}`).join('\n')}\n\n` +
            'Чтобы изменить: «Мои банки: Тинькофф, Наличные»'
          );
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/goals') {
        const currency = await getUserCurrency(userId).catch(() => 'RUB');
        const sym      = { USD: '$', EUR: '€', RUB: '₽', BYN: 'Br', CNY: '¥' }[currency] || currency;
        const goalSnap = await db.collection('goals')
          .where('userId', '==', userId)
          .orderBy('createdAt', 'desc')
          .limit(20)
          .get();
        if (goalSnap.empty) {
          await sendMessage(token, chatId, 'Целей пока нет 🎯\n\nСоздай первую: «Хочу накопить на отпуск 50 000»');
        } else {
          const bar = (cur, target) => {
            const pct    = Math.min(cur / (target || 1), 1);
            const filled = Math.round(pct * 10);
            return '▓'.repeat(filled) + '░'.repeat(10 - filled);
          };
          const lines = goalSnap.docs.map(d => {
            const g   = d.data();
            const cur = g.currentAmount || 0;
            const pct = Math.min(Math.round(cur / g.targetAmount * 100), 100);
            const dl  = g.deadline
              ? `\n📅 ${new Date(g.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : '';
            return `🎯 <b>${g.title}</b>\n${bar(cur, g.targetAmount)} ${pct}% (${cur} / ${g.targetAmount} ${sym})${dl}\nID: <code>${d.id}</code>`;
          });
          await sendMessage(token, chatId, `🎯 <b>Цели накопления:</b>\n\n${lines.join('\n\n')}`);
        }
        res.status(200).json({ ok: true }); return;
      }
      if (text === '/generate' || text === '/post' || text.startsWith('/generate ') || text.startsWith('/post ')) {
        if (!isAdminChatId(chatId)) {
          await sendMessage(token, chatId, '⛔ Только для администраторов.');
          res.status(200).json({ ok: true }); return;
        }
        const docRef = db.collection('content_queue').doc();
        await docRef.set({
          status:    'generating', chatId, userId,
          source:    'telegram-command',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        handleContentGeneration(docRef.id, chatId, token).catch(err =>
          console.error('[WH][gen] unhandled:', err.message)
        );
        res.status(200).json({ ok: true }); return;
      }
    } // end text-only flows

    // ── [7] ACCESS GATE (text + photo + voice) ───────────────────────────────
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

    // ── [8a] VISION — photo message ──────────────────────────────────────────
    if (photos) {
      await sendChatAction(token, chatId, 'upload_photo');
      const caption = message.caption ? String(message.caption).slice(0, 1024) : null;

      const visionTypingInterval = setInterval(() => {
        sendChatAction(token, chatId, 'upload_photo').catch(() => {});
      }, 4000);

      let description;
      try {
        description = await handlePhotoMessage(token, chatId, photos, caption);
      } catch (err) {
        console.error('[WH][vision] error:', err.message);
        description = null;
      } finally {
        clearInterval(visionTypingInterval);
      }

      const replyText = description
        ? `🖼 ${description}`
        : '⚠️ Не удалось проанализировать изображение. Попробуй ещё раз.';

      const visionDelay = Math.min(Math.max(replyText.length * 50, 1000), 4000);
      await new Promise(r => setTimeout(r, visionDelay));

      await sendMessage(token, chatId, replyText);

      const userHistoryMsg = caption ? `[фото] ${caption}` : '[фото]';
      await Promise.all([
        saveMessage(userId, 'user', userHistoryMsg).catch(() => {}),
        saveMessage(userId, 'assistant', replyText).catch(() => {}),
      ]);

      if (usingTrial) {
        await incrementTrialUsed(userId);
        const used = trialUsed + 1;
        if (TRIAL_LIMIT - used > 0) {
          await sendMessage(token, chatId, `💬 Пробный запрос ${used} из ${TRIAL_LIMIT}`);
        } else {
          await sendTrialExhaustedPrompt(token, chatId);
        }
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ── [8b] VOICE — STT → chatWithTools ─────────────────────────────────────
    if (voice) {
      await sendChatAction(token, chatId);

      const voiceTypingInterval = setInterval(() => {
        sendChatAction(token, chatId).catch(() => {});
      }, 4000);

      let transcription;
      try {
        transcription = await handleVoiceMessage(token, voice);
      } catch (err) {
        clearInterval(voiceTypingInterval);
        console.error('[WH][voice] STT error:', err.message);
        const errMsg = err.message.includes('OPENAI_API_KEY not set')
          ? '🎤 Голосовые сообщения временно недоступны.'
          : '🎤 Не удалось распознать речь. Попробуй ещё раз или напиши текстом.';
        await sendMessage(token, chatId, errMsg);
        res.status(200).json({ ok: true });
        return;
      }

      if (!transcription) {
        clearInterval(voiceTypingInterval);
        await sendMessage(token, chatId, '🎤 Не удалось распознать речь. Попробуй ещё раз или напиши текстом.');
        res.status(200).json({ ok: true });
        return;
      }

      const voiceHistory = await loadHistory(userId, sub.active).catch(() => []);

      let voiceReply;
      try {
        const { text: response } = await chatWithTools(transcription, userId, chatId, voiceHistory);
        voiceReply = response || 'Не удалось получить ответ.';
      } catch (aiErr) {
        console.error('[WH][8b] voice chatWithTools error:', aiErr.message);
        voiceReply = 'Извините, временно не могу обработать запрос. Попробуйте позже.';
      } finally {
        clearInterval(voiceTypingInterval);
      }

      const voiceDelay = Math.min(Math.max(voiceReply.length * 50, 1000), 4000);
      await new Promise(r => setTimeout(r, voiceDelay));

      await sendMessage(token, chatId, voiceReply, { disable_web_page_preview: true });

      await Promise.all([
        saveMessage(userId, 'user', transcription).catch(() => {}),
        saveMessage(userId, 'assistant', voiceReply).catch(() => {}),
      ]);

      if (usingTrial) {
        await incrementTrialUsed(userId);
        const used = trialUsed + 1;
        if (TRIAL_LIMIT - used > 0) {
          await sendMessage(token, chatId, `💬 Пробный запрос ${used} из ${TRIAL_LIMIT}`);
        } else {
          await sendTrialExhaustedPrompt(token, chatId);
        }
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ── [8c] CHAT WITH TOOLS — text message ──────────────────────────────────
    await sendChatAction(token, chatId);

    const history = await loadHistory(userId, sub.active).catch(() => []);

    const textTypingInterval = setInterval(() => {
      sendChatAction(token, chatId).catch(() => {});
    }, 4000);

    let replyText;
    try {
      const { text: response } = await chatWithTools(text, userId, chatId, history);
      replyText = response || 'Не удалось получить ответ.';
    } catch (aiErr) {
      console.error('[WH][8c] chatWithTools error:', aiErr.message);
      replyText = 'Извините, временно не могу обработать запрос. Попробуйте позже.';
    } finally {
      clearInterval(textTypingInterval);
    }

    const textDelay = Math.min(Math.max(replyText.length * 50, 1000), 4000);
    await new Promise(r => setTimeout(r, textDelay));

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
