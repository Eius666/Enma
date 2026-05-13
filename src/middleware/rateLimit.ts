/**
 * In-memory sliding-window rate limiter (TypeScript).
 *
 * NOTE: In serverless environments (Vercel, AWS Lambda) each function instance
 * has its own memory.  This limiter only prevents burst abuse within a single
 * warm container.  For distributed / cross-instance limiting use Redis or
 * Vercel KV.  It is still a worthwhile first line of defence.
 */

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const windows = new Map<string, number[]>();

/**
 * @returns true if the request is allowed, false if rate-limited.
 */
export function rateLimit(key: string, config: RateLimitConfig): boolean {
  const now = Date.now();
  const timestamps = (windows.get(key) ?? []).filter(t => now - t < config.windowMs);
  if (timestamps.length >= config.maxRequests) return false;
  timestamps.push(now);
  windows.set(key, timestamps);
  return true;
}

/** Presets for common use cases. */
export const LIMITS = {
  /** Reminder sends: 10/min per IP */
  SEND_MESSAGE: { maxRequests: 10, windowMs: 60_000 } satisfies RateLimitConfig,
  /** Webhook ingestion: 30/min per IP */
  WEBHOOK: { maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,
  /** Finance mutations: 60/min per user */
  FINANCE_WRITE: { maxRequests: 60, windowMs: 60_000 } satisfies RateLimitConfig,
} as const;
