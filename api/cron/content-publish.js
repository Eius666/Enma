'use strict';

// Content publisher — runs every hour (Vercel cron).
// Takes approved posts with scheduledAt <= now and publishes them to:
//   1. Telegram channel (TELEGRAM_CONTENT_CHANNEL_ID)
//   2. Threads (if THREADS_ACCESS_TOKEN + THREADS_USER_ID are set)
//
// Retry logic: on failure, reschedules +10 min, up to 3 retries.
// After 3 failures → status: 'failed', no more retries.

const { db, admin } = require('../_lib/firebaseAdmin');
const { tgPost }    = require('../_lib/content/adminSender');
const { generateImage } = require('../_lib/content/generator');

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerOk = req.headers.authorization === `Bearer ${secret}`;
  const queryOk  = req.query?.secret === secret;
  return headerOk || queryOk;
}

async function publishToTelegram(token, channelId, post) {
  const text = post.telegramText || post.text || post.idea;

  if (post.imageUrl) {
    const msg = await tgPost(token, 'sendPhoto', {
      chat_id: channelId,
      photo:   post.imageUrl,
      caption: text.slice(0, 1024),
    });
    return msg.message_id;
  }

  const msg = await tgPost(token, 'sendMessage', {
    chat_id: channelId,
    text,
  });
  return msg.message_id;
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const token     = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CONTENT_CHANNEL_ID;

  if (!token || !channelId) {
    res.status(200).json({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CONTENT_CHANNEL_ID not set — nothing to publish',
    });
    return;
  }

  const nowMs = Date.now();

  try {
    // Single equality filter only — no composite index needed.
    // Filter scheduledAt in memory, same pattern as reminders.js.
    const snap = await db.collection('content_queue')
      .where('status', '==', 'approved')
      .limit(20)
      .get();

    const limitParam = parseInt(req.query?.limit, 10);
    // Default 1: image generation takes up to 14s; with maxDuration:30 we can
    // safely process 1 post (14s image + overhead). Use ?limit=N to override.
    const maxPosts   = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 1;

    const dueDocs = snap.docs.filter(d => {
      const s = d.data().scheduledAt;
      if (!s) return true; // no scheduledAt = publish immediately
      const ts = s.toDate ? s.toDate() : new Date(s);
      return ts <= new Date(nowMs);
    }).slice(0, maxPosts);

    if (!dueDocs.length) {
      res.status(200).json({ ok: true, published: 0 });
      return;
    }

    const results = [];

    for (const docSnap of dueDocs) {
      const docRef = docSnap.ref;

      // Claim post in a transaction to prevent double-publish across concurrent invocations
      const post = await db.runTransaction(async tx => {
        const latest = await tx.get(docRef);
        if (!latest.exists) return null;
        if (latest.data().status !== 'approved') return null;
        tx.update(docRef, {
          status:    'publishing',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return latest.data();
      });

      if (!post) continue;

      const retryCount = post.retryCount || 0;

      // ── Stage 2: generate image if prompt exists but imageUrl is missing ──
      // Runs here (maxDuration:30) not in the webhook callback (10s limit).
      // On any failure the post still publishes — text only, no image.
      if (post.imagePrompt && !post.imageUrl) {
        try {
          console.error('[content-publish] generating image for doc', docRef.id);
          await docRef.update({ status: 'generating_image', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          const imageUrl = await generateImage(post.imagePrompt, 14_000);
          await docRef.update({ imageUrl, status: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          post = { ...post, imageUrl };
          console.error('[content-publish] image generated:', imageUrl.slice(0, 60));
        } catch (imgErr) {
          console.error('[content-publish] image generation failed:', imgErr.message, '— publishing text only');
          await docRef.update({ status: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      }

      try {
        // ── Telegram ──────────────────────────────────────────────────────────
        const telegramMsgId = await publishToTelegram(token, channelId, post);

        // ── Threads ────────────────────────────────────────────────────────────
        // Requires Meta App Review for threads_content_publish permission.
        // Enable by setting THREADS_ENABLED=true in env once App Review is approved.
        let threadsMediaId = null;
        if (post.platforms?.threads && process.env.THREADS_ENABLED === 'true') {
          try {
            const threadsClient = require('../_lib/threads-client');
            if (threadsClient.isConfigured()) {
              threadsMediaId = await threadsClient.publish(
                post.threadsText || post.text || post.idea,
                post.imageUrl || null
              );
            }
          } catch (threadsErr) {
            console.error('[content-publish] Threads error:', threadsErr.message);
            // Don't fail the whole publish if Threads fails — Telegram is primary
          }
        }

        await docRef.update({
          status:            'published',
          telegramMessageId: String(telegramMsgId),
          threadsMediaId,
          publishedAt:       admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        });

        await db.collection('content_logs').add({
          event:             'post_published',
          docId:             docRef.id,
          telegramMessageId: String(telegramMsgId),
          threadsMediaId,
          createdAt:         admin.firestore.FieldValue.serverTimestamp(),
        });

        results.push({ id: docRef.id, ok: true, telegramMsgId });
      } catch (err) {
        console.error('[content-publish] publish error:', err.message);

        if (retryCount < 3) {
          const retryAt = new Date(Date.now() + 10 * 60 * 1000);
          await docRef.update({
            status:      'approved',
            scheduledAt: admin.firestore.Timestamp.fromDate(retryAt),
            retryCount:  retryCount + 1,
            lastError:   err.message,
            updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
          });
          results.push({ id: docRef.id, ok: false, retry: retryCount + 1, error: err.message });
        } else {
          await docRef.update({
            status:    'failed',
            lastError: err.message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          results.push({ id: docRef.id, ok: false, failed: true, error: err.message });
        }
      }
    }

    const published = results.filter(r => r.ok).length;
    res.status(200).json({ ok: true, published, total: results.length, results });
  } catch (err) {
    console.error('[content-publish] fatal:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
