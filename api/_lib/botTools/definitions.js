'use strict';

// Tool definitions (OpenAI function-calling format) offered to the model by
// the Telegram assistant (api/_lib/llm-chat.js). Re-exported by tools.js.

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Создать напоминание. Используй когда пользователь просит напомнить что-либо.',
      parameters: {
        type: 'object',
        properties: {
          title:         { type: 'string', description: 'Текст напоминания' },
          relative_time: { type: 'string', description: 'Время ТОЧНО как сказал пользователь: "через 5 минут", "в 23:30", "завтра в 9 утра", "через 2 часа". НЕ конвертируй в ISO — передай оригинальную фразу.' },
          description:   { type: 'string', description: 'Дополнительное описание (опционально)' },
        },
        required: ['title', 'relative_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать задачу. Используй когда пользователь хочет добавить задачу или дело.',
      parameters: {
        type: 'object',
        properties: {
          title:         { type: 'string', description: 'Название задачи' },
          date:          { type: 'string', description: 'Дата YYYY-MM-DD (если известна)' },
          relative_time: { type: 'string', description: 'Время ТОЧНО как сказал пользователь: "в 14:00", "в 9 утра", "завтра в 10:00". НЕ конвертируй — передай оригинальную фразу.' },
          description:   { type: 'string', description: 'Описание (опционально)' },
          category: {
            type: 'string',
            enum: ['work', 'personal', 'health', 'study', 'finance', 'other'],
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_transaction',
      description: 'Записать расход или доход. Используй когда пользователь упоминает сумму и на что потратил/получил.',
      parameters: {
        type: 'object',
        properties: {
          amount:      { type: 'number', description: 'Сумма' },
          currency:    { type: 'string', enum: ['RUB', 'USD', 'EUR', 'CNY', 'BYN', 'GBP', 'KZT', 'TRY', 'AED', 'JPY', 'CHF'], description: 'Валюта операции, ТОЛЬКО если пользователь явно её назвал ("$5000", "80 юаней" → CNY, "1000 руб" → RUB). Если не названа — не указывай: сервер подставит текущую валюту ввода пользователя.' },
          description: { type: 'string', description: 'Описание' },
          type:        { type: 'string', enum: ['expense', 'income'] },
          category:    { type: 'string', description: 'Категория (еда, транспорт, зарплата, etc.)' },
          bank:        { type: 'string', description: 'Банк или платёжный метод (Тинькофф, Сбербанк, Наличные, etc.). Спроси если у пользователя настроены банки.' },
          goalId:      { type: 'string', description: 'ID цели накопления если транзакция связана с целью' },
        },
        required: ['amount', 'description', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_reminders',
      description: 'Показать список напоминаний пользователя.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'sent', 'all'] },
          limit:  { type: 'number', description: 'Максимальное количество (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_tasks',
      description: 'Показать список задач пользователя.',
      parameters: {
        type: 'object',
        properties: {
          date:  { type: 'string', description: 'Фильтр по дате YYYY-MM-DD (опционально)' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_transactions',
      description: 'Показать историю расходов/доходов.',
      parameters: {
        type: 'object',
        properties: {
          type:  { type: 'string', enum: ['expense', 'income', 'all'] },
          limit: { type: 'number' },
          bank:  { type: 'string', description: 'Фильтр по банку/платёжному методу (опционально)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_timezone',
      description: 'Установить часовой пояс пользователя. Используй когда пользователь говорит где он находится или просит сменить часовой пояс.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone, например Europe/Warsaw, Europe/Moscow, America/New_York',
          },
        },
        required: ['timezone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Найти актуальную информацию: курсы валют, погода, новости, цены.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по описанию. Используй когда пользователь просит нарисовать, создать картинку, сгенерировать изображение.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Описание изображения на английском' },
          style:  {
            type: 'string',
            description: 'Стиль изображения (опционально)',
            enum: ['photo', 'illustration', '3d', 'anime', 'minimalist', 'pixel-art'],
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_finance_stats',
      description: 'Показать статистику расходов и доходов пользователя. Используй когда спрашивают про траты, бюджет, сколько потратил.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Период: today, week, month, all (по умолчанию month)',
            enum: ['today', 'week', 'month', 'all'],
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Отправить текстовое сообщение в указанный чат от имени бота. Используй когда пользователь просит отправить кому-то сообщение. Бот может отправлять только в чаты, где он уже есть участником или пользователь написал боту /start. Если chat_id не указан — спроси у пользователя.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'ID целевого чата (числовой ID или @username канала/группы)' },
          text:    { type: 'string', description: 'Текст сообщения' },
        },
        required: ['chat_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_automation',
      description: 'Создать повторяющееся автоматическое действие. Например: "каждый день в 8:00 напоминай про таблетки" или "каждый понедельник присылай расписание".',
      parameters: {
        type: 'object',
        properties: {
          name:          { type: 'string', description: 'Краткое название автоматизации' },
          message_text:  { type: 'string', description: 'Текст сообщения который бот будет отправлять' },
          schedule_type: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Тип повторения' },
          time:          { type: 'string', description: 'Время HH:MM по местному времени пользователя' },
          days_of_week:  { type: 'array',  items: { type: 'integer' }, description: 'Дни недели 1=Пн…7=Вс. Обязательно если schedule_type=weekly' },
          day_of_month:  { type: 'integer', description: 'День месяца 1-31. Обязательно если schedule_type=monthly' },
        },
        required: ['name', 'message_text', 'schedule_type', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_automations',
      description: 'Показать список активных автоматизаций пользователя.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_automation',
      description: 'Удалить автоматизацию по ID.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'ID автоматизации' },
        },
        required: ['automation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_automation',
      description: 'Поставить автоматизацию на паузу или возобновить.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'ID автоматизации' },
          action:        { type: 'string', enum: ['pause', 'resume'] },
        },
        required: ['automation_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_message',
      description: 'Переслать сообщение из текущего чата пользователя в другой чат. Нужен message_id пересылаемого сообщения. Если chat_id не указан — спроси у пользователя.',
      parameters: {
        type: 'object',
        properties: {
          chat_id:      { type: 'string',  description: 'ID целевого чата' },
          from_chat_id: { type: 'string',  description: 'ID чата-источника (по умолчанию текущий чат пользователя — не указывай если не нужно)' },
          message_id:   { type: 'integer', description: 'ID сообщения для пересылки' },
        },
        required: ['chat_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_banks',
      description: 'Сохранить список банков/платёжных методов пользователя. Используй когда пользователь называет свои банки или хочет обновить список.',
      parameters: {
        type: 'object',
        properties: {
          banks: { type: 'array', items: { type: 'string' }, description: 'Список банков/методов оплаты, например ["Тинькофф", "Сбербанк", "Наличные"]' },
        },
        required: ['banks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_banks',
      description: 'Получить список банков/платёжных методов пользователя.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_goal',
      description: 'Создать цель накопления. Используй когда пользователь хочет накопить на что-то конкретное.',
      parameters: {
        type: 'object',
        properties: {
          title:        { type: 'string', description: 'Название цели, например "Отпуск в Испании"' },
          targetAmount: { type: 'number', description: 'Целевая сумма' },
          currency:     { type: 'string', enum: ['RUB', 'USD', 'EUR', 'BYN', 'CNY'], description: 'Валюта цели, ТОЛЬКО если пользователь явно назвал валюту (например "$20000" или "20000 долларов" → USD). Если валюта не названа — не указывай этот параметр, будет использована текущая валюта пользователя.' },
          deadline:     { type: 'string', description: 'Дедлайн YYYY-MM-DD (опционально)' },
          category:     { type: 'string', description: 'Категория цели (опционально): travel, car, home, education, other' },
        },
        required: ['title', 'targetAmount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deposit_to_goal',
      description: 'Пополнить цель накопления на сумму.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели (из list_goals)' },
          amount: { type: 'number', description: 'Сумма пополнения' },
        },
        required: ['goalId', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'withdraw_from_goal',
      description: 'Снять средства с цели накопления.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели (из list_goals)' },
          amount: { type: 'number', description: 'Сумма снятия' },
        },
        required: ['goalId', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_goals',
      description: 'Показать все цели накопления пользователя с прогрессом.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_goal',
      description: 'Удалить цель накопления.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели' },
        },
        required: ['goalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_finance_pdf',
      description: 'Сформировать и отправить ПОЛНОЦЕННЫЙ PDF-файл финансового отчёта (сводка, доходы/расходы по категориям, счета, цели/копилки, полная история операций). Используй именно этот инструмент, когда пользователь явно просит PDF, выгрузку, экспорт отчёта или файл ("сделай PDF", "выгрузи все операции", "подготовь отчёт по финансам за сентябрь") — НЕ get_finance_stats (тот только для текстовой статистики в чате). НИКОГДА не отвечай, что PDF сделать невозможно — этот инструмент существует именно для этого.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'week', 'month', 'quarter', 'year', 'all', 'custom'],
            description: 'Период отчёта. По умолчанию "all". Для "последние три месяца" используй quarter. Для конкретного месяца/диапазона, который не укладывается в стандартные периоды ("за сентябрь", "с 1 по 15 июня") — используй "custom" и вычисли dateFrom/dateTo сам.',
          },
          dateFrom: { type: 'string', description: 'YYYY-MM-DD — только при period="custom".' },
          dateTo:   { type: 'string', description: 'YYYY-MM-DD — только при period="custom".' },
          includeTransactions: { type: 'boolean', description: 'Включить полную историю операций (по умолчанию true).' },
          includeCategories:   { type: 'boolean', description: 'Включить аналитику по категориям (по умолчанию true).' },
          includeAccounts:     { type: 'boolean', description: 'Включить раздел по счетам/банкам (по умолчанию true).' },
          includeGoals:         { type: 'boolean', description: 'Включить раздел по целям/копилкам (по умолчанию true).' },
          includeCharts:        { type: 'boolean', description: 'Включить простые графики (по умолчанию true).' },
        },
      },
    },
  },
];

module.exports = { TOOL_DEFINITIONS };
