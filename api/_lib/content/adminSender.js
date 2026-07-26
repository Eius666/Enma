'use strict';

// Sends content moderation messages to the admin's personal Telegram chat.
// Admin chat ID is separate from the public TELEGRAM_CONTENT_CHANNEL_ID:
//   CONTENT_ADMIN_CHAT_ID — admin's personal chat ID for moderation
//   TELEGRAM_CONTENT_CHANNEL_ID — public channel where posts are published

const TELEGRAM_API = 'https://api.telegram.org';

function getAdminChatId() {
  const id = process.env.CONTENT_ADMIN_CHAT_ID;
  if (!id) throw new Error('CONTENT_ADMIN_CHAT_ID not set');
  return id;
}

async function tgPost(token, method, body) {
  const resp = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.result;
}

// Callback data schema:
//   ci_{action}_{docId}  — idea-level: ci = content_idea
//   cd_{action}_{docId}  — draft-level: cd = content_draft
// Actions for ideas:  approve | regen | skip
// Actions for drafts: approve | edit | reimg | skip

async function sendIdeaToAdmin(token, docId, idea, idx, total) {
  const adminChatId = getAdminChatId();

  const formatLabel = { single: 'пост', thread: 'тред', meme: 'мем' }[idea.format] || idea.format;
  const text = `💡 Идея ${idx}/${total} [${formatLabel}]\n\n` +
    `<b>${escHtml(idea.title)}</b>\n` +
    `${escHtml(idea.angle)}`;

  return tgPost(token, 'sendMessage', {
    chat_id: adminChatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Одобрить',    callback_data: `ci_approve_${docId}` },
        { text: '🔄 Заново',      callback_data: `ci_regen_${docId}`   },
        { text: '❌ Пропустить',  callback_data: `ci_skip_${docId}`    },
      ]],
    },
  });
}

async function sendDraftToAdmin(token, docId, draft) {
  const adminChatId = getAdminChatId();

  const tgText = draft.telegramText || draft.text || '';
  const thText = draft.threadsText  || '';
  const prompt  = draft.imagePrompt  || '';

  const preview =
    `📝 <b>Превью поста</b>\n\n` +
    `<b>Telegram:</b>\n${escHtml(tgText)}\n\n` +
    `<b>Threads:</b>\n${escHtml(thText)}` +
    (prompt ? `\n\n🎨 <i>Prompt: ${escHtml(prompt.slice(0, 100))}${prompt.length > 100 ? '…' : ''}</i>` : '');

  return tgPost(token, 'sendMessage', {
    chat_id: adminChatId,
    text: preview,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ В очередь',      callback_data: `cd_approve_${docId}` },
          { text: '✏️ Изменить текст', callback_data: `cd_edit_${docId}`    },
        ],
        [
          { text: '🎨 Другой prompt',  callback_data: `cd_reimg_${docId}`   },
          { text: '❌ Отклонить',      callback_data: `cd_skip_${docId}`    },
        ],
      ],
    },
  });
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  try {
    await tgPost(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || '',
    });
  } catch (_) {
    // Telegram invalidates callback query IDs after 60 s — ignore errors
  }
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendIdeaToAdmin, sendDraftToAdmin, answerCallbackQuery, tgPost, escHtml };
