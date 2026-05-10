module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  const { chatId, text } = req.body || {};
  if (!chatId || !text) {
    res.status(400).json({ ok: false, description: 'Missing chatId or text' });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, description: 'Missing TELEGRAM_BOT_TOKEN' });
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const payload = await response.json();
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, description: 'Telegram request failed' });
  }
};
