'use strict';

const { db }                = require('./_lib/firebaseAdmin');
const { checkSubscription } = require('./_lib/ai/subscription');
const { routeMessage }      = require('./_lib/ai/router');
const { buildSystemPrompt } = require('./_lib/ai/systemPrompt');

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'BYN', 'CNY', 'RUB'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { userId, messages } = req.body ?? {};

  // 1. Validate input
  if (!userId || typeof userId !== 'string') {
    res.status(400).json({ ok: false, error: 'userId required' });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ ok: false, error: 'messages array required' });
    return;
  }

  // Sanitise messages: only keep role + content, cap length
  const sanitised = messages.slice(-40).map(m => ({
    role: String(m.role) === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, 4096),
  }));

  try {
    // 2. Subscription gate — no AI without active subscription
    const { active, plan } = await checkSubscription(userId);
    if (!active) {
      res.status(403).json({
        ok: false,
        error: 'Для использования AI-ассистента необходима подписка',
      });
      return;
    }

    // 3. Fetch user context for personalised system prompt
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const currency = SUPPORTED_CURRENCIES.includes(userData.currency) ? userData.currency : 'RUB';
    const name     = typeof userData.name === 'string' ? userData.name : '';

    // 4. Build system prompt and route
    const systemPrompt = buildSystemPrompt({ currency, name });
    const { response, provider, model } = await routeMessage(sanitised, systemPrompt);

    // 5. Respond
    res.status(200).json({ ok: true, response, provider, model, plan });
  } catch (error) {
    console.error('[chat] error:', error);
    res.status(500).json({ ok: false, error: 'AI-ассистент временно недоступен' });
  }
};
