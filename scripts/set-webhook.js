if (parseInt(process.versions.node) < 18) {
  console.error('Node.js 18+ required (built-in fetch). Current:', process.version);
  process.exit(1);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://enma-silk.vercel.app/api/telegram/webhook';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

async function setWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
    return;
  }
  if (!WEBHOOK_SECRET) {
    console.error('Missing TELEGRAM_WEBHOOK_SECRET — webhook will reject all Telegram requests.');
    return;
  }

  const params = new URLSearchParams({ url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET });
  console.log(`Registering webhook: ${WEBHOOK_URL}`);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?${params}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.ok) {
      console.log('Webhook registered successfully.');
    } else {
      console.error('Failed to register webhook:', data.description);
    }
  } catch (error) {
    console.error('Network error:', error.message);
  }
}

setWebhook();
