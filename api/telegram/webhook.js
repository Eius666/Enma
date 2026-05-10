const { admin, db } = require('../_lib/firebaseAdmin');

const TELEGRAM_API = 'https://api.telegram.org';

const sendTelegramMessage = async (token, chatId, text) => {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Basic NLP Parser for transactions
 * Examples: 
 * "100 coffee" -> amount: 100, desc: "coffee", type: "expense"
 * "+500 gift"  -> amount: 500, desc: "gift", type: "income"
 * "зарплата 1000" -> amount: 1000, desc: "зарплата", type: "income"
 */
const parseTransaction = (text) => {
  const clean = text.trim();
  
  // Regular expression to find a number
  const numMatch = clean.match(/(\d+(?:[.,]\d+)?)/);
  if (!numMatch) return null;

  const amount = parseFloat(numMatch[1].replace(',', '.'));
  const description = clean.replace(numMatch[1], '').trim() || 'No description';
  
  // Determine type
  let type = 'expense';
  if (clean.startsWith('+') || clean.toLowerCase().includes('доход') || clean.toLowerCase().includes('income')) {
    type = 'income';
  }

  return { amount, description, type };
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const { message } = req.body;

  if (!message || !message.text || !message.chat) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  const text = message.text;

  try {
    // 1. Find user by chatId
    const userQuery = await db.collection('users').where('chatId', '==', chatId).limit(1).get();
    if (userQuery.empty) {
      await sendTelegramMessage(token, chatId, '⚠️ Привет! Пожалуйста, сначала открой Мини-Апп (Enma), чтобы мы могли привязать твой аккаунт.');
      res.status(200).json({ ok: true });
      return;
    }

    const userId = userQuery.docs[0].id;

    // 2. Parse message
    const parsed = parseTransaction(text);
    if (!parsed) {
      // If it's just a message, we can ignore or reply with help
      if (text.startsWith('/start')) {
          await sendTelegramMessage(token, chatId, 'Привет! Я Enma. Ты можешь записывать расходы прямо здесь.\nПример: "150 кофе" или "+200 кешбэк"');
      }
      res.status(200).json({ ok: true });
      return;
    }

    // 3. Create transaction
    const transactionId = createId();
    const transaction = {
      id: transactionId,
      userId,
      type: parsed.type,
      amount: parsed.amount,
      categoryId: 'cat-default', // We can improve this by matching categories
      description: parsed.description,
      date: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'telegram-bot'
    };

    await db.collection('transactions').doc(transactionId).set(transaction);

    // 4. Confirm
    const typeLabel = parsed.type === 'income' ? 'Доход' : 'Расход';
    await sendTelegramMessage(token, chatId, `✅ Записано: ${typeLabel} ${parsed.amount} — ${parsed.description}`);
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};
