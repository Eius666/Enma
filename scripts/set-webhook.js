const fetch = require('node-fetch');
const { APP_URL } = require('../api/_lib/appUrl');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = `${APP_URL}/api/telegram/webhook`;

async function setWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN in environment variables.');
    return;
  }

  console.log(`🚀 Registering webhook: ${WEBHOOK_URL}`);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.ok) {
      console.log('✅ Webhook registered successfully!');
    } else {
      console.error('❌ Failed to register webhook:', data.description);
    }
  } catch (error) {
    console.error('❌ Network error:', error.message);
  }
}

setWebhook();
