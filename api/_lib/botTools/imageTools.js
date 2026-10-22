'use strict';

// generate_image: asks the image model (OpenRouter) for a picture and sends
// it to the chat via the bot. Stateless — no database access.

async function generateImage(args, chatId) {
  const { prompt, style } = args;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const model  = process.env.IMAGE_GEN_MODEL || 'openai/gpt-image-1';

  const fullPrompt = style ? `${prompt}, ${style} style` : prompt;
  console.log('[generate_image] model:', model, '| prompt:', fullPrompt.slice(0, 80));

  const res = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify({ model, prompt: fullPrompt, n: 1, size: '1024x1024' }),
    signal:  AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[generate_image] API error:', res.status, err.slice(0, 200));
    return { ok: false, error: `Ошибка генерации (${res.status}). Попробуй позже.` };
  }

  const data     = await res.json();
  const imageUrl = data.data?.[0]?.url || null;
  const b64      = data.data?.[0]?.b64_json || null;

  if (!imageUrl && !b64) {
    console.error('[generate_image] no image in response:', JSON.stringify(data).slice(0, 200));
    return { ok: false, error: 'Модель не вернула изображение.' };
  }

  if (imageUrl) {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: `🎨 ${prompt}` }),
    });
  } else {
    // b64 response — send as file upload
    const formData = new FormData();
    const blob = new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
    formData.append('chat_id', String(chatId));
    formData.append('caption', `🎨 ${prompt}`);
    formData.append('photo', blob, 'image.png');
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
  }

  return { ok: true, message: '🖼 Картинка отправлена!' };
}

module.exports = { generateImage };
