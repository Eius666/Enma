'use strict';

const { db, admin } = require('../firebaseAdmin');

const FREE_CONTEXT_LIMIT    = 10;
const PRO_CONTEXT_LIMIT     = 50;
const MAX_CONTEXT_TOKENS    = 8000;
const CHARS_PER_TOKEN       = 4;

async function saveMessage(userId, role, content) {
  if (!userId || !content) return;
  await db.collection('messages').add({
    userId,
    role,
    content: content.slice(0, 8000),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Load conversation history for LLM context.
// Returns array of { role, content } sorted oldest-first.
async function loadHistory(userId, isPro = false) {
  const limit = isPro ? PRO_CONTEXT_LIMIT : FREE_CONTEXT_LIMIT;

  const snap = await db.collection('messages')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  if (snap.empty) return [];

  // Reverse to oldest-first
  const all = snap.docs.reverse().map(d => ({
    role:    d.data().role,
    content: d.data().content,
  }));

  // Trim to approximate token budget (keep newest messages)
  let chars = 0;
  const trimmed = [];
  for (let i = all.length - 1; i >= 0; i--) {
    chars += all[i].content.length;
    if (chars / CHARS_PER_TOKEN > MAX_CONTEXT_TOKENS) break;
    trimmed.unshift(all[i]);
  }

  return trimmed;
}

module.exports = { saveMessage, loadHistory };
