'use strict';

// Rate limiter with Vercel KV backend and in-memory fallback.
//
// When KV_REST_API_URL is set, uses @vercel/kv for cross-container rate
// limiting (required in production where Vercel may spin up multiple
// serverless instances). Falls back to in-memory when KV is not configured
// (local dev) or when the KV call itself fails.
//
// NOTE: @vercel/kv must be installed separately:
//   npm install @vercel/kv

let kv = null;
if (process.env.KV_REST_API_URL) {
  try {
    kv = require('@vercel/kv').kv;
  } catch {
    console.warn('[rateLimit] @vercel/kv not installed — using in-memory fallback');
  }
}

// In-memory sliding-window store (single warm container only).
const windows = new Map();

function rateLimitInMemory(key, maxRequests, windowMs) {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  windows.set(key, timestamps);
  return true;
}

async function rateLimitKV(key, maxRequests, windowMs) {
  const ttlSeconds = Math.ceil(windowMs / 1000);
  const count = await kv.incr(key);
  // Set expiry only on the first increment so the window has a fixed lifetime.
  if (count === 1) {
    await kv.expire(key, ttlSeconds);
  }
  return count <= maxRequests;
}

/**
 * @param {string} key        — identifier, e.g. `ip:${ip}` or `bot:${chatId}`
 * @param {number} maxRequests — allowed requests inside the window
 * @param {number} windowMs    — window size in milliseconds
 * @returns {Promise<boolean>} true = allowed, false = rate-limited
 */
async function rateLimit(key, maxRequests, windowMs) {
  if (kv) {
    try {
      return await rateLimitKV(key, maxRequests, windowMs);
    } catch (err) {
      console.warn('[rateLimit] KV error, falling back to in-memory:', err.message);
    }
  }
  return rateLimitInMemory(key, maxRequests, windowMs);
}

/**
 * Extract caller IP, respecting Vercel's X-Forwarded-For header.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

module.exports = { rateLimit, getClientIp };
