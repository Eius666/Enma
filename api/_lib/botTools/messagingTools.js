'use strict';

// send_message and forward_message: plain Bot API calls. Stateless.

async function sendBotMessage(args) {
  const { chat_id, text } = args;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
    signal:  AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));

  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    console.error('[send_message] TG error:', desc);
    return { ok: false, error: `Telegram: ${desc}` };
  }
  return { ok: true, message: `✅ Сообщение отправлено в чат ${chat_id}` };
}

async function forwardBotMessage(args, defaultChatId) {
  const { chat_id, message_id } = args;
  const from_chat_id = args.from_chat_id || String(defaultChatId);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const resp = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id, from_chat_id, message_id }),
    signal:  AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));

  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    console.error('[forward_message] TG error:', desc);
    return { ok: false, error: `Telegram: ${desc}` };
  }
  return { ok: true, message: `✅ Сообщение переслано в чат ${chat_id}` };
}

module.exports = { sendBotMessage, forwardBotMessage };
