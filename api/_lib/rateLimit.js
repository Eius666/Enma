'use strict';

// Sliding-window in-memory rate limiter.
//
// NOTE: Vercel serverless functions do NOT share memory across invocations, so
// this only prevents burst abuse within a single warm instance. For
// cross-instance limiting, use an external store (Redis / KV). It is still
// useful: it stops rapid retry loops from a single attacker hitting the same
// warm container.

const windows = new Map();

/**
 * @param {string} key        — identifier, e.g. `ip:${ip}` or `bot:${chatId}`
 * @param {number} maxRequests — allowed requests inside the window
 * @param {number} windowMs    — sliding window size in milliseconds
 * @returns {boolean} true = allowed, false = rate-limited
 */
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  windows.set(key, timestamps);
  return true;
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
