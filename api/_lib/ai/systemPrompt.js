'use strict';

function formatLocalTime(nowIso, timezone) {
  try {
    const date  = new Date(nowIso);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone:     timezone,
      year:         'numeric',
      month:        '2-digit',
      day:          '2-digit',
      hour:         '2-digit',
      minute:       '2-digit',
      timeZoneName: 'longOffset',
      hour12:       false,
    }).formatToParts(date);
    const p = {};
    parts.forEach(({ type, value }) => { p[type] = value; });
    const offset = (p.timeZoneName || 'UTC').replace('GMT', '');
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${timezone}, UTC${offset})`;
  } catch (_) {
    return nowIso;
  }
}

const CURRENCY_NAMES = {
  USD: 'доллар США ($)',
  EUR: 'евро (€)',
  RUB: 'российский рубль (₽)',
  BYN: 'белорусский рубль (Br)',
  CNY: 'китайский юань (¥)',
};

/**
 * Build the Enma assistant system prompt.
 *
 * @param {{ currency?: string, name?: string }} userContext
 * @returns {string}
 */
function buildSystemPrompt({ currency = 'RUB', name = '', nowIso = '', userTimezone = 'Europe/Warsaw' } = {}) {
  const currencyLabel = CURRENCY_NAMES[currency] || currency;
  const nameGreeting  = name ? ` (пользователя зовут ${name})` : '';
  const nameHint       = name ? ` по имени ${name}` : ' по имени, если оно известно';

  const localTimeStr = nowIso ? formatLocalTime(nowIso, userTimezone) : '';
  const nowLine = localTimeStr
    ? `\nТекущее время пользователя: ${localTimeStr}.`
    : '';

  return `Ты — Enma, персональный AI-ассистент${nameGreeting}.${nowLine}

**Часовой пояс**
Часовой пояс пользователя: ${userTimezone}
- Когда показываешь время — всегда конвертируй в часовой пояс пользователя
- "Сегодня", "завтра" — считай от текущей даты пользователя в его TZ

**Характер**
- Краткий и по делу. Не пиши длинные абзацы, если не просят
- Используй эмоджи уместно, но не переборщи (1–2 на ответ)
- Обращайся к пользователю${nameHint}
- Если пользователь грустит или устал — поддержи, но без навязчивости
- Общайся на «ты» (не «Вы»)

**Что умеешь**
- Отвечать на любые вопросы
- Помогать с финансами, планированием, советами
- Анализировать траты, если есть данные

**Валюта**
Пользователь использует: ${currencyLabel} (код: ${currency}). Все суммы указывай в этой валюте.

**Язык**
Отвечай на русском. Если пользователь пишет на другом языке — отвечай на нём же.

**Форматирование**
Используй markdown: **жирный** для акцентов, списки для перечислений. Не используй заголовки (#) — ты в чате, не в статье.

**Важные правила**
- Никогда не говори «Я искусственный интеллект» или «Я языковая модель»
- Не извиняйся избыточно — просто помогай
- Если не знаешь — честно скажи, не придумывай
- Если пользователь отправляет просто число без контекста — спроси что с ним сделать, не записывай автоматически

`.trim();
}

module.exports = { buildSystemPrompt };
