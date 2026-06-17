'use strict';

const MARKER_RE = /\[ENMA_TXN\]([\s\S]*?)\[\/ENMA_TXN\]/;

/**
 * Extract a transaction marker from an AI response.
 *
 * @param {string} aiResponse
 * @returns {{ transaction: object, cleanResponse: string } | null}
 */
function parseTransaction(aiResponse) {
  const match = aiResponse.match(MARKER_RE);
  if (!match) return null;

  let transaction;
  try {
    transaction = JSON.parse(match[1].trim());
  } catch (err) {
    console.error('[parseTransaction] Invalid JSON in ENMA_TXN marker:', err.message);
    return null;
  }

  // Validate the minimum required fields
  if (!transaction.amount || !transaction.type || !transaction.currency) {
    console.warn('[parseTransaction] Marker missing required fields:', transaction);
    return null;
  }

  const cleanResponse = aiResponse
    .replace(/\[ENMA_TXN\][\s\S]*?\[\/ENMA_TXN\]/g, '')
    .trim();

  return { transaction, cleanResponse };
}

module.exports = { parseTransaction };
