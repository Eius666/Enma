'use strict';

// Handles Telegram callback_query events for content moderation.
// Called from api/telegram/webhook.js when update.callback_query is present.
//
// Callback data format:
//   ci_{action}_{docId}  — idea actions (approve / regen / skip)
//   cd_{action}_{docId}  — draft actions (approve / edit / reimg / skip)
//
// Admin state machine (Firestore admin_states/{chatId}):
//   { action: 'edit_text', contentId: '...' }  — waiting for admin to type new text

const { db, admin } = require('../firebaseAdmin');
const { generateIdeas, generatePost } = require('./generator');
const { sendIdeaToAdmin, sendDraftToAdmin, answerCallbackQuery, tgPost } = require('./adminSender');

function isContentCallback(data) {
  return /^(ci|cd)_(approve|regen|skip|edit|reimg)_\S+$/.test(data || '');
}

function isAdminChatId(chatId) {
  const adminId = process.env.CONTENT_ADMIN_CHAT_ID;
  if (!adminId) return false;
  return String(chatId) === String(adminId);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function handleCallbackQuery(token, callbackQuery) {
  const { id: queryId, data, message, from } = callbackQuery;

  if (!isAdminChatId(from?.id)) {
    await answerCallbackQuery(token, queryId, '❌ Нет доступа');
    return;
  }

  // Answer immediately so Telegram doesn't show spinner
  await answerCallbackQuery(token, queryId);

  const match = data.match(/^(ci|cd)_(approve|regen|skip|edit|reimg)_(.+)$/);
  if (!match) return;

  const [, type, action, docId] = match;
  const chatId = from.id;

  try {
    const docRef = db.collection('content_queue').doc(docId);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      await tgPost(token, 'sendMessage', { chat_id: chatId, text: '❌ Пост не найден' });
      return;
    }

    const doc = docSnap.data();

    if (type === 'ci') {
      await handleIdeaAction(token, chatId, docRef, doc, docId, action, message);
    } else {
      await handleDraftAction(token, chatId, docRef, doc, docId, action, message);
    }
  } catch (err) {
    console.error('[moderationHandler] callback error:', err.message);
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text: `❌ Ошибка: ${err.message.slice(0, 150)}`,
    }).catch(() => {});
  }
}

// ── Idea actions ──────────────────────────────────────────────────────────────

async function handleIdeaAction(token, chatId, docRef, doc, docId, action, origMessage) {
  if (action === 'skip') {
    await docRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await editOrSend(token, chatId, origMessage?.message_id,
      `❌ Пропущено: ${doc.idea}`);
    return;
  }

  if (action === 'regen') {
    await editOrSend(token, chatId, origMessage?.message_id, `🔄 Генерирую новую идею…`);
    const ideas = await generateIdeas(new Date());
    if (!ideas.length) throw new Error('Не удалось сгенерировать идеи');
    const newIdea = ideas[0];

    await docRef.update({
      idea:  newIdea.title,
      angle: newIdea.angle,
      format: newIdea.format || 'single',
      status: 'idea',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const msg = await sendIdeaToAdmin(token, docId, newIdea, 1, 1);
    await docRef.update({ adminMessageId: msg.message_id });
    return;
  }

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
  }
}

// ── Draft actions ─────────────────────────────────────────────────────────────

async function handleDraftAction(token, chatId, docRef, doc, docId, action, origMessage) {
  if (action === 'skip') {
    await docRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await tgPost(token, 'sendMessage', { chat_id: chatId, text: '❌ Пост отклонён' });
    return;
  }

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
    const { generatePost: gen } = require('./generator');
    const postData = await gen({ title: doc.idea, angle: doc.angle });
    await docRef.update({
      imagePrompt: postData.imagePrompt || doc.imagePrompt,
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    await tgPost(token, 'sendMessage', {
      chat_id: chatId,
      text:
        `🎨 Новый prompt для картинки:\n\n<code>${postData.imagePrompt || '(пустой)'}</code>`,
      parse_mode: 'HTML',
    });
  }
}

// ── Conversational state: awaiting edited text ────────────────────────────────

async function handleAdminTextMessage(token, chatId, text) {
  // Check for /cancel command first
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

  const docRef = db.collection('content_queue').doc(state.contentId);
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

// ── Utils ─────────────────────────────────────────────────────────────────────

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
