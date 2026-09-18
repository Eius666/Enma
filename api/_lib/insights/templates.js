'use strict';

// ── Deterministic insight text templates — no LLM required ───────────────────
// LLM is NOT used as a detector or text generator for standard events.

function fmtAmount(n) {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('ru-RU');
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return `${Math.round(n)}%`;
}

const TEMPLATES = {
  'finance.cash_gap': {
    ru: {
      title: (f) =>
        `Прогнозный кассовый разрыв — ${fmtAmount(f.gapAmount)} ₽`,
      body: (f) =>
        `К концу месяца прогнозный баланс может составить ${fmtAmount(f.projectedBalance)} ₽. ` +
        `Текущий баланс: ${fmtAmount(f.currentBalance)} ₽.`,
    },
    en: {
      title: (f) => `Projected cash gap — ${fmtAmount(f.gapAmount)} ₽`,
      body:  (f) =>
        `Projected month-end balance: ${fmtAmount(f.projectedBalance)} ₽. ` +
        `Current balance: ${fmtAmount(f.currentBalance)} ₽.`,
    },
  },

  'finance.payment_cluster': {
    ru: {
      title: (f) => `${f.count} платежа на ${fmtAmount(f.total)} ₽ в ближайшие дни`,
      body:  (f) => `С ${f.from} по ${f.to}: ${f.count} платежа, сумма ${fmtAmount(f.total)} ₽.`,
    },
    en: {
      title: (f) => `${f.count} payments (${fmtAmount(f.total)} ₽) coming up`,
      body:  (f) => `${f.count} payments totaling ${fmtAmount(f.total)} ₽ from ${f.from} to ${f.to}.`,
    },
  },

  'finance.category_spike': {
    ru: {
      title: (f) => `Расходы «${f.category}» выросли на ${fmtPct(f.increasePct)}`,
      body:  (f) =>
        `${fmtAmount(f.current)} ₽ в этом месяце против ${fmtAmount(f.baseline)} ₽ — ` +
        `рост на ${fmtAmount(f.increase)} ₽.`,
    },
    en: {
      title: (f) => `"${f.category}" spending up ${fmtPct(f.increasePct)}`,
      body:  (f) =>
        `${fmtAmount(f.current)} ₽ this month vs ${fmtAmount(f.baseline)} ₽ — ` +
        `an increase of ${fmtAmount(f.increase)} ₽.`,
    },
  },

  'finance.goal_off_track': {
    ru: {
      title: (f) => `Цель «${f.goalTitle}» отстаёт от плана`,
      body:  (f) =>
        `Нужно ${fmtAmount(f.requiredMonthly)} ₽/мес, фактический темп ${fmtAmount(f.actualMonthly)} ₽/мес. ` +
        `Нехватка: ${fmtAmount(f.monthlyGap)} ₽ в месяц.`,
    },
    en: {
      title: (f) => `Goal "${f.goalTitle}" is off track`,
      body:  (f) =>
        `Need ${fmtAmount(f.requiredMonthly)} ₽/mo, current pace ${fmtAmount(f.actualMonthly)} ₽/mo. ` +
        `Gap: ${fmtAmount(f.monthlyGap)} ₽/mo.`,
    },
  },

  'tasks.overdue': {
    ru: {
      title: (f) => {
        const d = f.overdueDays;
        const label = d === 1 ? '1 день' : `${d} дн.`;
        return `Задача «${f.taskTitle}» просрочена на ${label}`;
      },
      body: (f) => `Дедлайн был ${f.dueDate}. Задача ещё не выполнена.`,
    },
    en: {
      title: (f) => `Task "${f.taskTitle}" is ${f.overdueDays} day(s) overdue`,
      body:  (f) => `Deadline was ${f.dueDate}. Task is still open.`,
    },
  },

  'system.month_review_ready': {
    ru: {
      title: (f) => `${f.monthLabel} завершён — финансовый разбор готов`,
      body:  ()  => `Посмотри, как прошёл месяц: доходы, расходы и ключевые паттерны.`,
    },
    en: {
      title: (f) => `${f.monthLabel} is over — monthly review ready`,
      body:  ()  => `See how the month went: income, expenses, and key patterns.`,
    },
  },
};

const MONTH_NAMES = {
  '01': { ru: 'Январь',   en: 'January'   },
  '02': { ru: 'Февраль',  en: 'February'  },
  '03': { ru: 'Март',     en: 'March'     },
  '04': { ru: 'Апрель',   en: 'April'     },
  '05': { ru: 'Май',      en: 'May'       },
  '06': { ru: 'Июнь',     en: 'June'      },
  '07': { ru: 'Июль',     en: 'July'      },
  '08': { ru: 'Август',   en: 'August'    },
  '09': { ru: 'Сентябрь', en: 'September' },
  '10': { ru: 'Октябрь',  en: 'October'   },
  '11': { ru: 'Ноябрь',   en: 'November'  },
  '12': { ru: 'Декабрь',  en: 'December'  },
};

function getMonthLabel(yearMonth, lang) {
  const mm = String(yearMonth).slice(5, 7);
  return MONTH_NAMES[mm]?.[lang] || yearMonth;
}

function renderInsightText(type, facts, lang = 'ru') {
  const tpl = TEMPLATES[type]?.[lang] || TEMPLATES[type]?.['ru'];
  if (!tpl) return { title: type, body: '' };
  try {
    return { title: tpl.title(facts), body: tpl.body(facts) };
  } catch {
    return { title: type, body: '' };
  }
}

module.exports = { renderInsightText, getMonthLabel, MONTH_NAMES };
