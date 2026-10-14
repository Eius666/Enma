'use strict';

// Renders a structured finance-report-data object (financeReportData.js)
// into an actual PDF Buffer, via pdfkit — pure, synchronous given its
// input (no Firestore, no FX, no network): feed it the same data twice,
// get byte-identical output twice (module-load timestamps aside — the
// generation date comes from data.meta.generatedAtISO, not Date.now()).
//
// Font: DejaVu Sans (Regular + Bold), bundled directly in ./fonts/ under
// the SIL/Bitstream Vera license in that directory. Chosen after directly
// testing pdfkit's font embedding (not assumed): a WOFF2 Google-Fonts
// Inter subset embedded fine visually but produced a BROKEN ToUnicode
// table (extracted text came back as near-total null bytes, even for
// plain ASCII) — a real, reproduced pdfkit/fontkit WOFF2 issue, not a
// Cyrillic-specific one. Plain TTF embedding (this font) round-trips
// perfectly for Latin, Cyrillic, and — critically — ₽/₸/₺ (confirmed via
// fontkit's hasGlyphForCodePoint; common "safe" fonts like Liberation
// Sans are missing all three of those).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_REGULAR = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD     = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

const PAGE_MARGIN = 50;
const COLOR_TEXT       = '#1a1a2e';
const COLOR_MUTED      = '#6b7280';
const COLOR_ACCENT     = '#6c5ce7'; // ENMA's purple accent, used elsewhere in the app
const COLOR_INCOME     = '#2ecc71';
const COLOR_EXPENSE    = '#ff4757';
const COLOR_ROW_ALT    = '#f5f5fa';
const COLOR_RULE       = '#e5e5ef';

const CURRENCY_SYMBOLS = { RUB: '₽', USD: '$', EUR: '€', BYN: 'Br', CNY: '¥', GBP: '£', KZT: '₸', TRY: '₺', AED: 'AED', JPY: '¥', CHF: 'CHF' };
function sym(ccy) { return CURRENCY_SYMBOLS[ccy] || ccy || ''; }

function fmtMoney(value, currency) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  const formatted = n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${sym(currency)}`;
}

function fmtPct(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr).slice(0, 10);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const TYPE_LABELS = { expense: 'Расход', income: 'Доход' };

const SECTION_FLAGS = {
  includeTransactions: 'transactions',
  includeCategories:   'categories',
  includeAccounts:     'accounts',
  includeGoals:        'goals',
  includeCharts:       'charts',
};

// ── Low-level layout helpers ─────────────────────────────────────────────

function pageContentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
    return true;
  }
  return false;
}

function heading(doc, text, { size = 16 } = {}) {
  ensureSpace(doc, size + 20);
  doc.font(FONT_BOLD).fontSize(size).fillColor(COLOR_TEXT).text(text);
  doc.moveDown(0.3);
  const y = doc.y;
  doc.save().strokeColor(COLOR_ACCENT).lineWidth(2)
    .moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + 60, y).stroke().restore();
  doc.moveDown(0.6);
}

function subheading(doc, text) {
  ensureSpace(doc, 24);
  doc.font(FONT_BOLD).fontSize(12).fillColor(COLOR_TEXT).text(text);
  doc.moveDown(0.3);
}

function paragraph(doc, text, { size = 10, color = COLOR_TEXT } = {}) {
  doc.font(FONT_REGULAR).fontSize(size).fillColor(color).text(text, { align: 'left' });
}

function kvRow(doc, label, value, { valueColor = COLOR_TEXT, bold = false } = {}) {
  ensureSpace(doc, 20);
  const width = pageContentWidth(doc);
  const y = doc.y;
  doc.font(FONT_REGULAR).fontSize(11).fillColor(COLOR_MUTED).text(label, doc.page.margins.left, y, { width: width * 0.6 });
  doc.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(11).fillColor(valueColor)
    .text(value, doc.page.margins.left + width * 0.6, y, { width: width * 0.4, align: 'right' });
  doc.moveDown(0.15);
}

// pdfkit's own `lineBreak: false` + `ellipsis: true` combination does NOT
// reliably keep a cell to one line in every version — confirmed directly
// (a "Пополнение цели"-length string still wrapped to two lines inside a
// narrow column, which would then visually overlap the row below, since
// drawTable advances by a fixed row height). Truncating the STRING itself
// to a measured width, before it ever reaches pdfkit's text layout, is the
// only way to guarantee a cell never exceeds one line.
function truncateToWidth(doc, text, maxWidth, { font = FONT_REGULAR, size = 9 } = {}) {
  const str = String(text);
  doc.font(font).fontSize(size);
  if (doc.widthOfString(str) <= maxWidth) return str;
  const ellipsis = '…';
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = str.slice(0, mid) + ellipsis;
    if (doc.widthOfString(candidate) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ellipsis : str.slice(0, lo) + ellipsis;
}

// A minimal, from-scratch table renderer (pdfkit has no table primitive).
// Repeats the header row on every new page a table spills onto, and never
// lets a row straddle a page break — ensureSpace() forces a fresh page
// before a row that wouldn't fully fit, so nothing is ever visually cut
// off mid-row regardless of how many rows the table has.
function drawTable(doc, { columns, rows, zebra = true }) {
  const totalWidth = pageContentWidth(doc);
  const widths = columns.map(c => c.width * totalWidth);
  const rowHeight = 20;

  function drawHeader() {
    ensureSpace(doc, rowHeight + 4);
    const y = doc.y;
    doc.save().rect(doc.page.margins.left, y, totalWidth, rowHeight).fill(COLOR_ACCENT).restore();
    let x = doc.page.margins.left;
    columns.forEach((c, i) => {
      const cellWidth = widths[i] - 8;
      const label = truncateToWidth(doc, c.label, cellWidth, { font: FONT_BOLD });
      doc.font(FONT_BOLD).fontSize(9).fillColor('#ffffff')
        .text(label, x + 4, y + 5, { width: cellWidth, height: rowHeight - 5, align: c.align || 'left', lineBreak: false });
      x += widths[i];
    });
    doc.y = y + rowHeight;
  }

  drawHeader();
  rows.forEach((row, idx) => {
    if (ensureSpace(doc, rowHeight)) drawHeader();
    const y = doc.y;
    if (zebra && idx % 2 === 1) {
      doc.save().rect(doc.page.margins.left, y, totalWidth, rowHeight).fill(COLOR_ROW_ALT).restore();
    }
    let x = doc.page.margins.left;
    columns.forEach((c, i) => {
      const val = typeof c.value === 'function' ? c.value(row) : row[c.key];
      const cellWidth = widths[i] - 8;
      const text = truncateToWidth(doc, val == null ? '' : String(val), cellWidth, { font: FONT_REGULAR });
      doc.font(FONT_REGULAR).fontSize(9).fillColor(row._color || COLOR_TEXT)
        .text(text, x + 4, y + 5, { width: cellWidth, height: rowHeight - 5, align: c.align || 'left', lineBreak: false });
      x += widths[i];
    });
    doc.y = y + rowHeight;
  });
  doc.moveDown(0.5);
}

// Simple horizontal bar chart — deliberately vector rects, not a charting
// library or <canvas>: no extra native dependency, renders identically
// everywhere a PDF viewer can draw a filled rectangle.
function drawBarChart(doc, { items, valueFmt, maxBars = 8 }) {
  const top = items.slice(0, maxBars);
  if (top.length === 0) return;
  const max = Math.max(...top.map(i => Math.abs(i.value)), 1);
  const totalWidth = pageContentWidth(doc);
  const labelWidth = totalWidth * 0.3;
  const barAreaWidth = totalWidth - labelWidth - 70;
  const barHeight = 14;
  const gap = 8;

  ensureSpace(doc, (barHeight + gap) * top.length + 10);
  top.forEach(item => {
    const y = doc.y;
    const label = truncateToWidth(doc, item.label, labelWidth - 6, { size: 9 });
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_TEXT)
      .text(label, doc.page.margins.left, y + 2, { width: labelWidth - 6, height: barHeight, lineBreak: false });
    const barWidth = Math.max(2, (Math.abs(item.value) / max) * barAreaWidth);
    doc.save().rect(doc.page.margins.left + labelWidth, y, barWidth, barHeight).fill(item.color || COLOR_ACCENT).restore();
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED)
      .text(valueFmt(item.value), doc.page.margins.left + labelWidth + barAreaWidth + 6, y + 2, { width: 64, height: barHeight, lineBreak: false });
    doc.y = y + barHeight + gap;
  });
  doc.moveDown(0.4);
}

// ── Section renderers ─────────────────────────────────────────────────────

function renderTitlePage(doc, data) {
  const { meta, summary } = data;
  doc.moveDown(6);
  doc.font(FONT_BOLD).fontSize(30).fillColor(COLOR_ACCENT).text('ENMA', { align: 'center' });
  doc.font(FONT_BOLD).fontSize(20).fillColor(COLOR_TEXT).text('Финансовый отчёт', { align: 'center' });
  doc.moveDown(2);

  const infoY = doc.y;
  const lines = [
    ['Период', meta.period.label],
    ['Дата формирования', fmtDate(meta.generatedAtISO)],
    ['Валюта отчётности', `${meta.currency} (${sym(meta.currency)})`],
    ['Количество операций', String(meta.transactionCount)],
  ];
  doc.font(FONT_REGULAR).fontSize(12).fillColor(COLOR_TEXT);
  lines.forEach(([label, value], i) => {
    doc.text(`${label}: `, doc.page.margins.left + 60, infoY + i * 22, { continued: true, width: 400 });
    doc.font(FONT_BOLD).text(value);
    doc.font(FONT_REGULAR);
  });
  doc.y = infoY + lines.length * 22 + 20;
}

function renderSummary(doc, data) {
  doc.addPage();
  heading(doc, 'Финансовая сводка');
  const { summary, meta } = data;
  kvRow(doc, 'Доходы за период', fmtMoney(summary.income, meta.currency), { valueColor: COLOR_INCOME });
  kvRow(doc, 'Расходы за период', fmtMoney(summary.expense, meta.currency), { valueColor: COLOR_EXPENSE });
  kvRow(doc, 'Разница доходов и расходов за период', fmtMoney(summary.net, meta.currency), { valueColor: summary.net >= 0 ? COLOR_INCOME : COLOR_EXPENSE, bold: true });
  doc.moveDown(0.3);
  kvRow(doc, 'Свободный баланс (доступно сейчас)', fmtMoney(summary.freeBalance, meta.currency), { bold: true });
  kvRow(doc, 'Накопления в целях', summary.savingsUnknown ? 'Невозможно точно определить' : fmtMoney(summary.savingsBalance, meta.currency));
  kvRow(doc, 'Общий объём средств (свободный баланс + накопления)',
    summary.totalFunds === null ? 'Невозможно точно определить' : fmtMoney(summary.totalFunds, meta.currency), { bold: true });
  doc.moveDown(0.3);
  kvRow(doc, 'Количество операций за период', String(summary.transactionCount));
  kvRow(doc, 'Активных целей', String(summary.activeGoalsCount));
}

function renderCategoryAnalytics(doc, data, { charts }) {
  if (data.expenseByCategory.length === 0 && data.incomeByCategory.length === 0) return;
  doc.addPage();
  heading(doc, 'Аналитика расходов');
  if (data.expenseByCategory.length > 0) {
    drawTable(doc, {
      columns: [
        { key: 'category', label: 'Категория', width: 0.45 },
        { key: 'amount', label: 'Сумма', width: 0.3, align: 'right', value: r => fmtMoney(r.amount, data.meta.currency) },
        { key: 'pct', label: '% от расходов', width: 0.25, align: 'right', value: r => fmtPct(r.pct) },
      ],
      rows: data.expenseByCategory,
    });
    if (charts) {
      subheading(doc, 'Крупнейшие статьи расходов');
      drawBarChart(doc, {
        items: data.expenseByCategory.map(c => ({ label: c.category, value: c.amount, color: COLOR_EXPENSE })),
        valueFmt: v => fmtMoney(v, data.meta.currency),
      });
    }
  } else {
    paragraph(doc, 'За выбранный период расходов не было.', { color: COLOR_MUTED });
  }

  if (data.monthlyTrend.length > 1 && charts) {
    doc.moveDown(0.4);
    subheading(doc, 'Динамика по месяцам');
    drawTable(doc, {
      columns: [
        { key: 'yearMonth', label: 'Месяц', width: 0.34 },
        { key: 'income', label: 'Доходы', width: 0.33, align: 'right', value: r => fmtMoney(r.income, data.meta.currency) },
        { key: 'expense', label: 'Расходы', width: 0.33, align: 'right', value: r => fmtMoney(r.expense, data.meta.currency) },
      ],
      rows: data.monthlyTrend,
    });
  }
}

function renderIncomeAnalytics(doc, data) {
  if (data.incomeByCategory.length === 0) return;
  doc.addPage();
  heading(doc, 'Аналитика доходов');
  drawTable(doc, {
    columns: [
      { key: 'category', label: 'Источник', width: 0.45 },
      { key: 'amount', label: 'Сумма', width: 0.3, align: 'right', value: r => fmtMoney(r.amount, data.meta.currency) },
      { key: 'pct', label: '% от доходов', width: 0.25, align: 'right', value: r => fmtPct(r.pct) },
    ],
    rows: data.incomeByCategory,
  });
}

function renderAccounts(doc, data) {
  if (data.byBank.length === 0) return;
  doc.addPage();
  heading(doc, 'Счета и банки');
  paragraph(doc, 'Движение средств по счетам за выбранный период (расходы и доходы; переводы в копилки/из копилок показаны отдельно в разделе «Финансовые цели»).', { size: 9, color: COLOR_MUTED });
  doc.moveDown(0.4);
  drawTable(doc, {
    columns: [
      { key: 'bank', label: 'Счёт / банк', width: 0.34 },
      { key: 'income', label: 'Доходы', width: 0.22, align: 'right', value: r => fmtMoney(r.income, data.meta.currency) },
      { key: 'expense', label: 'Расходы', width: 0.22, align: 'right', value: r => fmtMoney(r.expense, data.meta.currency) },
      { key: 'net', label: 'Движение', width: 0.22, align: 'right', value: r => fmtMoney(r.net, data.meta.currency) },
    ],
    rows: data.byBank,
  });
  doc.moveDown(0.3);
  paragraph(doc, 'Это сумма операций за период, а не фактический банковский остаток — исходный баланс счёта ENMA не хранит, поэтому реальный остаток здесь не показан.', { size: 8, color: COLOR_MUTED });
}

function renderGoals(doc, data) {
  if (data.goals.length === 0) return;
  doc.addPage();
  heading(doc, 'Финансовые цели');
  data.goals.forEach((g, idx) => {
    if (idx > 0) doc.moveDown(0.6);
    ensureSpace(doc, 90);
    // Goal titles are free user text with no length limit elsewhere in the
    // app — truncated here so one long title can't run past the page's
    // right margin (subheading() has no width constraint of its own).
    subheading(doc, truncateToWidth(doc, g.title, pageContentWidth(doc), { font: FONT_BOLD, size: 12 }));
    kvRow(doc, 'Целевая сумма', fmtMoney(g.targetAmount, g.currency));
    kvRow(doc, 'Накоплено', fmtMoney(g.currentAmount, g.currency));
    kvRow(doc, 'Рублёвая стоимость накоплений (историческая)', g.currentAmountRub === null ? 'Невозможно точно определить' : fmtMoney(g.currentAmountRub, 'RUB'));
    kvRow(doc, 'Выполнено', fmtPct(g.pct));
    if (g.deadline) kvRow(doc, 'Дедлайн', g.deadline);
    if (g.relatedOps.length > 0) {
      doc.moveDown(0.2);
      drawTable(doc, {
        columns: [
          { key: 'date', label: 'Дата', width: 0.25, value: r => fmtDate(r.date) },
          { key: 'label', label: 'Операция', width: 0.35 },
          { key: 'amount', label: 'Сумма', width: 0.4, align: 'right', value: r => fmtMoney(r.amount, r.currency) },
        ],
        rows: g.relatedOps,
      });
    }
  });
}

function renderTransactions(doc, data) {
  if (data.transactions.length === 0) return;
  doc.addPage();
  heading(doc, 'Полная история операций');
  drawTable(doc, {
    columns: [
      { key: 'date', label: 'Дата', width: 0.10, value: r => fmtDate(r.date) },
      { key: 'description', label: 'Название', width: 0.18 },
      { key: 'type', label: 'Тип', width: 0.19, value: r => r.label || TYPE_LABELS[r.type] || r.type },
      { key: 'category', label: 'Категория', width: 0.11, value: r => r.category || '—' },
      { key: 'bank', label: 'Счёт', width: 0.10, value: r => r.bank || '—' },
      { key: 'amount', label: 'Сумма', width: 0.16, align: 'right', value: r => `${r.amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym(r.currency)}` },
      { key: 'rubAmount', label: 'В рублях', width: 0.16, align: 'right', value: r => r.rubAmount === null ? '—' : fmtMoney(r.rubAmount, 'RUB') },
    ],
    rows: data.transactions,
    zebra: true,
  });
}

function renderNotes(doc) {
  doc.addPage();
  heading(doc, 'Примечания', { size: 14 });
  paragraph(doc, 'Для валютных операций использованы зафиксированные при записи рублёвые эквиваленты. Исторические суммы не пересчитываются по текущему курсу.');
  doc.moveDown(0.6);
  paragraph(doc, 'Отчёт ENMA основан на пользовательских записях и не является банковской выпиской.');
}

function drawFooters(doc, generatedAtISO) {
  const range = doc.bufferedPageRange();
  const dateLabel = fmtDate(generatedAtISO).split(' ')[0];
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - doc.page.margins.bottom + 20;
    doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_MUTED);
    doc.text('ENMA', doc.page.margins.left, bottom, { lineBreak: false });
    doc.text(dateLabel, 0, bottom, { align: 'center', width: doc.page.width, lineBreak: false });
    doc.text(`Стр. ${i + 1} из ${range.count}`, 0, bottom, { align: 'right', width: doc.page.width - doc.page.margins.right, lineBreak: false });
  }
}

/**
 * @param {object} data - output of financeReportData.buildReportData.
 * @param {object} [options] - the include* flags from the export tool's parameters.
 * @returns {Promise<Buffer>}
 */
function renderFinanceReportPdf(data, options = {}) {
  const opts = {
    includeTransactions: true, includeCategories: true, includeAccounts: true,
    includeGoals: true, includeCharts: true,
    ...options,
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.registerFont('body', FONT_REGULAR);
      doc.registerFont('bold', FONT_BOLD);

      renderTitlePage(doc, data);
      renderSummary(doc, data);
      if (opts.includeCategories) {
        renderCategoryAnalytics(doc, data, { charts: opts.includeCharts });
        renderIncomeAnalytics(doc, data);
      }
      if (opts.includeAccounts) renderAccounts(doc, data);
      if (opts.includeGoals) renderGoals(doc, data);
      if (opts.includeTransactions) renderTransactions(doc, data);
      renderNotes(doc);

      drawFooters(doc, data.meta.generatedAtISO);
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderFinanceReportPdf, fmtMoney, fmtPct, fmtDate, SECTION_FLAGS };
