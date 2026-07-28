'use strict';

const { db, admin } = require('../firebaseAdmin');
const { ensureReferralCode } = require('./codes');

const TG = 'https://api.telegram.org';
const TON_ADDRESS_RE = /^[UE][A-Za-z0-9_-]{46,48}$/;

async function tg(token, method, body) {
  const resp = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// /referral — show link and stats
async function handleReferralCommand(token, chatId, userId) {
  const code = await ensureReferralCode(userId);
  const botUsername  = process.env.TELEGRAM_BOT_USERNAME || 'EnmaAI_bot';
  const referralLink = `https://t.me/${botUsername}?start=ref_${code}`;

  const [refSnap, userDoc] = await Promise.all([
    db.collection('referrals').where('referrerId', '==', userId).get(),
    db.collection('users').doc(userId).get(),
  ]);

  const total   = refSnap.size;
  const active  = refSnap.docs.filter(d => d.data().status === 'converted').length;
  const ud      = userDoc.data() || {};
  const earned  = (ud.totalEarningsUsd || 0).toFixed(2);
  const wallet  = ud.tonWalletAddress;

  const walletLine = wallet
    ? `💳 TON кошелёк: <code>${wallet.slice(0, 6)}...${wallet.slice(-4)}</code>`
    : '💳 TON кошелёк для выплат: не задан';

  await tg(token, 'sendMessage', {
    chat_id:    chatId,
    parse_mode: 'HTML',
    text:
      `📢 Твоя реферальная ссылка:\n<code>${referralLink}</code>\n\n` +
      `💰 15% с каждой оплаты реферала (пока он платит)\n` +
      `💵 Выплаты раз в месяц в TON\n` +
      `📊 Приглашено: ${total} | Активных: ${active} | Заработано: $${earned}\n\n` +
      walletLine,
    reply_markup: wallet ? undefined : {
      inline_keyboard: [[{ text: '💳 Указать кошелёк', callback_data: 'wallet_set' }]],
    },
  });
}

// /wallet — prompt user to send TON address
async function handleWalletCommand(token, chatId, userId) {
  await db.collection('user_states').doc(String(chatId)).set({
    action:    'set_ton_wallet',
    userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await tg(token, 'sendMessage', {
    chat_id:    chatId,
    parse_mode: 'HTML',
    text:
      '💳 Пришли адрес TON кошелька для выплат.\n\n' +
      'Адрес начинается с <b>U</b> или <b>E</b>, длина ~48 символов.\n' +
      'Например: <code>UQBjX…</code>\n\n' +
      'Отправь /cancel чтобы отменить.',
  });
}

// /balance — show payout summary
async function handleBalanceCommand(token, chatId, userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  const ud      = userDoc.data() || {};

  const pending  = (ud.pendingPayoutUsd    || 0).toFixed(2);
  const earned   = (ud.totalEarningsUsd    || 0).toFixed(2);
  const paid     = (ud.totalPaidUsd        || 0).toFixed(2);

  const now = new Date();
  const nextPayout = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const dateStr = nextPayout.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  await tg(token, 'sendMessage', {
    chat_id:    chatId,
    parse_mode: 'HTML',
    text:
      `💰 <b>Реферальный баланс</b>\n\n` +
      `💵 Ожидает выплаты: <b>$${pending}</b>\n` +
      `📈 Всего заработано: $${earned}\n` +
      `✅ Всего выплачено:  $${paid}\n\n` +
      `📅 Следующая выплата: ${dateStr}`,
  });
}

// Validate and save TON wallet address (called from user state machine)
async function handleWalletInput(token, chatId, userId, text) {
  const address = text.trim();

  if (address === '/cancel') {
    await db.collection('user_states').doc(String(chatId)).delete();
    await tg(token, 'sendMessage', { chat_id: chatId, text: '🚫 Отменено' });
    return true;
  }

  if (!TON_ADDRESS_RE.test(address)) {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text:
        '❌ Неверный формат TON адреса.\n' +
        'Адрес должен начинаться с U или E и содержать ~48 символов.\n\n' +
        'Попробуй ещё раз или отправь /cancel для отмены.',
    });
    return true;
  }

  await db.collection('users').doc(userId).set(
    { tonWalletAddress: address },
    { merge: true }
  );
  await db.collection('user_states').doc(String(chatId)).delete();

  await tg(token, 'sendMessage', {
    chat_id:    chatId,
    parse_mode: 'HTML',
    text: `✅ Кошелёк сохранён: <code>${address}</code>\n\nВыплаты будут приходить на этот адрес раз в месяц.`,
  });

  return true;
}

// Check if user has a pending wallet-setup state; returns true if handled.
async function checkUserState(token, chatId, userId, text) {
  const stateDoc = await db.collection('user_states').doc(String(chatId)).get();
  if (!stateDoc.exists) return false;

  const state = stateDoc.data();
  if (state.action === 'set_ton_wallet') {
    return handleWalletInput(token, chatId, userId, text);
  }
  return false;
}

module.exports = {
  handleReferralCommand,
  handleWalletCommand,
  handleBalanceCommand,
  handleWalletInput,
  checkUserState,
};
