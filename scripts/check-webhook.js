if (parseInt(process.versions.node) < 18) {
  console.error('Node.js 18+ required (built-in fetch). Current:', process.version);
  process.exit(1);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function getWebhookInfo() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN in environment variables.');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.ok) {
      console.log('✅ Webhook info:');
      console.log(JSON.stringify(data.result, null, 2));
    } else {
      console.error('❌ Failed to get webhook info:', data.description);
    }
  } catch (error) {
    console.error('❌ Network error:', error.message);
  }
}

getWebhookInfo();
