'use strict';

// Handles Telegram callback_query events for content moderation.
// Called from api/telegram/webhook.js when update.callback_query is present.
//
// Callback data format:
//   ci_{action}_{docId}  — idea-level:  approve | regen | skip | newstart
//   cd_{action}_{docId}  — draft-level: approve | edit  | reimg | skip
//   cs_{action}_{docId}  — post-skip options: regen_full | regen_text | delete
//
// Admin state machine (Firestore admin_states/{chatId}):
//   { action: 'edit_text', contentId: '...' }  — waiting for admin to type new text
//
// regenCount (Firestore field on content_queue docs):
//   Tracks how many regenerations have happened in this skip-chain.
//   Carried forward when a new doc is created as a replacement.
//   At REGEN_LIMIT the bot stops auto-generating and shows a "New idea" button.

const { db, admin } = require('../firebaseAdmin');
const { generateIdeas, generatePost, regenerateIdea, regeneratePost } = require('./generator');
const { sendIdeaToAdmin, sendDraftToAdmin, answerCallbackQuery, tgPost } = require('./adminSender');

const REGEN_LIMIT = 5;

// ── Callback routing ──────────────────────────────────────────────────────────

function isContentCallback(data) {
  return /^c[ids]_[a-z_]+_\S+$/.test(data || '');
}

function isAdminChatId(chatId) {
  const adminId = process.env.CONTENT_ADMIN_CHAT_ID;
  if (!adminId) return false;
  return String(chatId) === String(adminId);
}

async function handleCallbackQuery(token, callbackQuery) {
  const { id: queryId, data, message, from } = callbackQuery;

  if (!isAdminChatId(from?.id)) {
    await answerCallbackQuery(token, queryId, '❌ Нет доступа');
    return;
  }

  await answerCallbackQuery(token, queryId);

  // Prefix: ci | cd | cs
  // Action: approve | regen | skip | edit | reimg | newstart | regen_full | regen_text | delete
  const match = data.match(/^(ci|cd|cs)_([a-z_]+)_(.+)$/);
  if (!match) return;

  const [, prefix, action, docId] = match;
  const chatId = from.id;

  try {
    const docRef  = db.collection('content_queue').doc(docId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      await tgPost(token, 'sendMessage', { chat_id: chatId, text: '❌ Пост не найден' });
      return;
    }

    const doc = docSnap.data();

    if (prefix === 'ci') {
      await handleIdeaAction(token, chatId, docRef, doc, docId, action, message);
    } else if (prefix === 'cd') {
      await handleDraftAction(token, chatId, docRef, doc, docId, action, message);
    } else {
      await handlePostSkipAction(token, chatId, docRef, doc, docId, action, message);
    }
  } catch (err) {
    console.error('[moderationHandler] callback error:', err.message);
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: `❌ Ошибка: ${err.message.slice(0, 150)}`,
    }).catch(() => {});
  }
}

// ── Idea actions ──────���──────────────────────────────��────────────────────────

async function handleIdeaAction(token, chatId, docRef, doc, docId, action, origMessage) {

  // ── Approve ──────────────────────────────────────────────────────────────────
  if (action === 'approve') {
    await editOrSend(token, chatId, origMessage?.message_id,
      `⏳ Генерирую пост: «${doc.idea}»…`);
    await docRef.update({ status: 'generating', updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    const postData = await generatePost({ title: doc.idea, angle: doc.angle });
    const scheduledAt = nextHourSlot();

    await docRef.update({
      status:       'draft',
      text:         postData.threadsText || '',
      telegramText: postData.telegramText || postData.threadsText || '',
      threadsText:  postData.threadsText  || '',
      imagePrompt:  postData.imagePrompt  || '',
      imageUrl:     null,
      scheduledAt:  admin.firestore.Timestamp.fromDate(scheduledAt),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendDraftToAdmin(token, docId, postData);
    await docRef.update({ adminDraftMessageId: msg.message_id });
    return;
  }

  // ── Regen (keep same slot, update idea text) ──────────────────────────────
  if (action === 'regen') {
    const regenCount = (doc.regenCount || 0);
    if (regenCount >= REGEN_LIMIT) {
      await regenLimitReached(token, chatId, docId, origMessage);
      return;
    }

    await editOrSend(token, chatId, origMessage?.message_id, `🔄 Генерирую новую идею…`);

    const excluded = buildExcludedList(doc);
    const newIdea  = await regenerateIdea(excluded);

    await docRef.update({
      idea:       newIdea.title,
      angle:      newIdea.angle,
      format:     newIdea.format || 'single',
      status:     'idea',
      regenCount: regenCount + 1,
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendIdeaToAdmin(token, docId, newIdea, 1, 1);
    await docRef.update({ adminMessageId: msg.message_id });
    return;
  }

  // ── Skip: reject current, auto-generate a replacement ─────────────────────
  if (action === 'skip') {
    const regenCount = doc.regenCount || 0;

    // Mark current as rejected
    await docRef.update({
      status:    'rejected',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await editOrSend(token, chatId, origMessage?.message_id,
      `❌ Отклонено. Предлагаю альтернативу…`);

    if (regenCount >= REGEN_LIMIT) {
      await regenLimitReached(token, chatId, null, null);
      return;
    }

    // Generate a fresh replacement idea
    const excluded = buildExcludedList(doc);
    const newIdea  = await regenerateIdea(excluded);

    const newRef = db.collection('content_queue').doc();
    await newRef.set({
      idea:              newIdea.title,
      angle:             newIdea.angle,
      format:            newIdea.format || 'single',
      status:            'idea',
      type:              'single',
      text:              null,
      telegramText:      null,
      threadsText:       null,
      imageUrl:          null,
      imagePrompt:       null,
      scheduledAt:       null,
      publishedAt:       null,
      platforms:         { telegram: true, threads: true },
      telegramMessageId: null,
      threadsMediaId:    null,
      adminMessageId:    null,
      adminDraftMessageId: null,
      regenCount:        regenCount + 1,
      // Carry the full excluded chain so next skip also avoids all prior ideas
      excludedIdeas:     [...(doc.excludedIdeas || []), doc.idea].filter(Boolean),
      retryCount:        0,
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendIdeaToAdmin(token, newRef.id, newIdea, 1, 1);
    await newRef.update({ adminMessageId: msg.message_id });
    return;
  }

  // ── New-start button (shown after regen limit) ────────────────────────────
  if (action === 'newstart') {
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: `⏳ Генерирую новую идею с чистого листа…` });
    const newIdea = await generateIdeas(new Date()).then(ideas => ideas[0]);
    if (!newIdea) throw new Error('Не удалось сгенерировать идею');

    const newRef = db.collection('content_queue').doc();
    await newRef.set({
      idea:              newIdea.title,
      angle:             newIdea.angle,
      format:            newIdea.format || 'single',
      status:            'idea',
      type:              'single',
      text:              null,
      telegramText:      null,
      threadsText:       null,
      imageUrl:          null,
      imagePrompt:       null,
      scheduledAt:       null,
      publishedAt:       null,
      platforms:         { telegram: true, threads: true },
      telegramMessageId: null,
      threadsMediaId:    null,
      adminMessageId:    null,
      adminDraftMessageId: null,
      regenCount:        0,
      excludedIdeas:     [],
      retryCount:        0,
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendIdeaToAdmin(token, newRef.id, newIdea, 1, 1);
    await newRef.update({ adminMessageId: msg.message_id });
  }
}

// ── Draft actions ────��────────────────────────────────────────────────────────

async function handleDraftAction(token, chatId, docRef, doc, docId, action, origMessage) {

  if (action === 'approve') {
    await docRef.update({ status: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const scheduledAt = doc.scheduledAt?.toDate?.() || nextHourSlot();
    const timeStr = scheduledAt.toLocaleString('ru-RU', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
      day: 'numeric', month: 'short',
    });
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Пост в очереди. Публикация: ${timeStr} UTC`,
    });
    return;
  }

  if (action === 'edit') {
    await db.collection('admin_states').doc(String(chatId)).set({
      action:    'edit_text',
      contentId: docId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: '✏️ Пришли новый текст. Он заменит оба варианта (Telegram + Threads).\n\nОтправь /cancel чтобы отменить.',
    });
    return;
  }

  if (action === 'reimg') {
    const postData = await regeneratePost({ title: doc.idea, angle: doc.angle });
    await docRef.update({
      imagePrompt: postData.imagePrompt || doc.imagePrompt,
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: `🎨 Новый prompt для картинки:\n\n<code>${postData.imagePrompt || '(пустой)'}</code>`,
      parse_mode: 'HTML',
    });
    return;
  }

  // ── Skip draft: show 3-option keyboard ────────────────────────────────────
  if (action === 'skip') {
    await docRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: `❌ Пост отклонён. Что делаем дальше?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Новая тема + новый текст', callback_data: `cs_regen_full_${docId}` }],
          [{ text: '✏️ Та же тема, другой текст',  callback_data: `cs_regen_text_${docId}` }],
          [{ text: '🗑️ Удалить и забыть',          callback_data: `cs_delete_${docId}`     }],
        ],
      },
    });
  }
}

// ── Post-skip option actions (cs_ prefix) ────────────────────────────────────

async function handlePostSkipAction(token, chatId, docRef, doc, docId, action, origMessage) {
  if (action === 'delete') {
    await docRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: '🗑️ Удалено. Чистый лист.' });
    return;
  }

  const regenCount = doc.regenCount || 0;
  if (regenCount >= REGEN_LIMIT) {
    await regenLimitReached(token, chatId, null, null);
    return;
  }

  // ── Regen full: new idea → new post ──────────────────────────────────────
  if (action === 'regen_full') {
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: '⏳ Генерирую новую идею…' });

    const excluded = buildExcludedList(doc);
    const newIdea  = await regenerateIdea(excluded);

    // Save as new idea doc (will go through full approval flow)
    const newRef = db.collection('content_queue').doc();
    await newRef.set({
      idea:              newIdea.title,
      angle:             newIdea.angle,
      format:            newIdea.format || 'single',
      status:            'idea',
      type:              'single',
      text:              null,
      telegramText:      null,
      threadsText:       null,
      imageUrl:          null,
      imagePrompt:       null,
      scheduledAt:       null,
      publishedAt:       null,
      platforms:         { telegram: true, threads: true },
      telegramMessageId: null,
      threadsMediaId:    null,
      adminMessageId:    null,
      adminDraftMessageId: null,
      regenCount:        regenCount + 1,
      excludedIdeas:     [...(doc.excludedIdeas || []), doc.idea].filter(Boolean),
      retryCount:        0,
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendIdeaToAdmin(token, newRef.id, newIdea, 1, 1);
    await newRef.update({ adminMessageId: msg.message_id });
    return;
  }

  // ── Regen text only: same idea, new text ──���──────────────────────────────
  if (action === 'regen_text') {
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: '⏳ Генерирую новый текст…' });

    const postData = await regeneratePost({ title: doc.idea, angle: doc.angle });
    const scheduledAt = nextHourSlot();

    const newRef = db.collection('content_queue').doc();
    await newRef.set({
      idea:              doc.idea,
      angle:             doc.angle,
      format:            doc.format || 'single',
      status:            'draft',
      type:              'single',
      text:              postData.threadsText || '',
      telegramText:      postData.telegramText || postData.threadsText || '',
      threadsText:       postData.threadsText  || '',
      imageUrl:          null,
      imagePrompt:       postData.imagePrompt  || '',
      scheduledAt:       admin.firestore.Timestamp.fromDate(scheduledAt),
      publishedAt:       null,
      platforms:         { telegram: true, threads: true },
      telegramMessageId: null,
      threadsMediaId:    null,
      adminMessageId:    null,
      adminDraftMessageId: null,
      regenCount:        regenCount + 1,
      excludedIdeas:     doc.excludedIdeas || [],
      retryCount:        0,
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendDraftToAdmin(token, newRef.id, postData);
    await newRef.update({ adminDraftMessageId: msg.message_id });
  }
}

// ── Conversational state: awaiting edited text ────────────────────────────────

async function handleAdminTextMessage(token, chatId, text) {
  if (text.trim() === '/cancel') {
    const stateDoc = await db.collection('admin_states').doc(String(chatId)).get();
    if (stateDoc.exists) {
      await db.collection('admin_states').doc(String(chatId)).delete();
      await tgPost(token, 'sendMessage', { chat_id: chatId, text: '🚫 Отменено' });
      return true;
    }
    return false;
  }

  const stateDoc = await db.collection('admin_states').doc(String(chatId)).get();
  if (!stateDoc.exists) return false;

  const state = stateDoc.data();
  if (state.action !== 'edit_text') return false;

  const docRef  = db.collection('content_queue').doc(state.contentId);
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    await db.collection('admin_states').doc(String(chatId)).delete();
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: '❌ Пост не найден' });
    return true;
  }

  await docRef.update({
    text:         text,
    telegramText: text,
    threadsText:  text.slice(0, 280),
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('admin_states').doc(String(chatId)).delete();

  const preview = text.slice(0, 200) + (text.length > 200 ? '…' : '');
  await tgPost(token, 'sendMessage', {
    chat_id: chatId,
    text:    `✅ Текст обновлён.\n\n${preview}`,
  });

  return true;
}

// ── Helpers ────────────────────────────────────��──────────────────────────────

function buildExcludedList(doc) {
  const prior = Array.isArray(doc.excludedIdeas) ? doc.excludedIdeas : [];
  return doc.idea ? [...prior, doc.idea] : prior;
}

async function regenLimitReached(token, chatId, docId, origMessage) {
  const regenMsg = `⚠️ Достигнут лимит регенераций (${REGEN_LIMIT}).`;
  const keyboard = {
    inline_keyboard: [[
      { text: '🔄 Новая идея с чистого листа', callback_data: `ci_newstart_${docId || 'new'}` },
    ]],
  };
  if (origMessage?.message_id) {
    try {
      await tgPost(token, 'editMessageText', {
        chat_id: chatId, message_id: origMessage.message_id, text: regenMsg,
      });
    } catch (_) {}
  }
  await tgPost(token, 'sendMessage', {
    chat_id: chatId,
    text: regenMsg + '\nХочешь начать заново с совершенно новой темой?',
    reply_markup: keyboard,
  });
}

function nextHourSlot() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

async function editOrSend(token, chatId, messageId, text) {
  if (messageId) {
    try {
      await tgPost(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text });
      return;
    } catch (_) {}
  }
  await tgPost(token, 'sendMessage', { chat_id: chatId, text });
}

module.exports = { handleCallbackQuery, handleAdminTextMessage, isContentCallback, isAdminChatId };
