'use strict';

const MAX_LEN = 4096;

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function processInline(raw) {
  // 1. Extract inline code spans — protect them from formatting passes
  const codes = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push('<code>' + escapeHtml(c) + '</code>');
    return '\x01' + (codes.length - 1) + '\x01';
  });

  // 2. Escape HTML in all remaining text
  text = escapeHtml(text);

  // 3. Apply Markdown formatting (bold before italic so ** is consumed first)
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  text = text.replace(/\*(.+?)\*/g, '<i>$1</i>');
  text = text.replace(/_(.+?)_/g, '<i>$1</i>');
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 4. Restore inline code placeholders
  text = text.replace(/\x01(\d+)\x01/g, (_, i) => codes[+i]);

  return text;
}

function markdownToTelegramHtml(text) {
  if (typeof text !== 'string') return '';

  const lines = text.split('\n');
  const out = [];
  let inCode = false;
  const codeBuf = [];

  for (const line of lines) {
    // Fenced code block delimiter
    if (line.startsWith('```')) {
      if (inCode) {
        out.push('<pre>' + escapeHtml(codeBuf.join('\n')) + '</pre>');
        codeBuf.length = 0;
        inCode = false;
      } else {
        inCode = true; // language hint on opening line is discarded
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    if (line.startsWith('> ')) {
      out.push('<blockquote>' + processInline(line.slice(2)) + '</blockquote>');
    } else if (/^#{1,6}\s/.test(line)) {
      out.push('<b>' + processInline(line.replace(/^#+\s+/, '')) + '</b>');
    } else if (/^[-*+]\s/.test(line)) {
      out.push('• ' + processInline(line.replace(/^[-*+]\s+/, '')));
    } else {
      out.push(processInline(line));
    }
  }

  // Flush unclosed code block
  if (inCode && codeBuf.length) {
    out.push('<pre>' + escapeHtml(codeBuf.join('\n')) + '</pre>');
  }

  return out.join('\n');
}

function splitHtmlMessage(text) {
  if (text.length <= MAX_LEN) return [text];

  const chunks = [];
  let current = '';

  for (const para of text.split('\n\n')) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length <= MAX_LEN) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (para.length <= MAX_LEN) {
        current = para;
      } else {
        // Paragraph itself exceeds limit — hard split
        for (let i = 0; i < para.length; i += MAX_LEN) {
          chunks.push(para.slice(i, i + MAX_LEN));
        }
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = { markdownToTelegramHtml, splitHtmlMessage };
