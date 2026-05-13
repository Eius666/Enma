/**
 * Input validation and sanitization utilities.
 * Use these at system boundaries — API handlers and form submissions.
 */

export interface ValidationResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Validate and trim a non-empty string. Optionally enforce max length. */
export function validateString(
  value: unknown,
  { maxLength = 2000, minLength = 1 }: { maxLength?: number; minLength?: number } = {}
): ValidationResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'Expected a string' };
  const trimmed = value.trim();
  if (trimmed.length < minLength) return { ok: false, error: `Minimum length is ${minLength}` };
  if (trimmed.length > maxLength) return { ok: false, error: `Maximum length is ${maxLength}` };
  return { ok: true, value: trimmed };
}

/** Validate a positive finite number. Optionally clamp to a range. */
export function validateNumber(
  value: unknown,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}
): ValidationResult<number> {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (typeof num !== 'number' || !isFinite(num)) return { ok: false, error: 'Expected a number' };
  if (num < min) return { ok: false, error: `Minimum value is ${min}` };
  if (num > max) return { ok: false, error: `Maximum value is ${max}` };
  return { ok: true, value: num };
}

/** Validate that a value is one of the allowed enum values. */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): ValidationResult<T> {
  if (typeof value !== 'string') return { ok: false, error: 'Expected a string' };
  if (!(allowed as readonly string[]).includes(value)) {
    return { ok: false, error: `Expected one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: value as T };
}

/** Validate a positive integer (e.g. Telegram chat/user IDs). */
export function validatePositiveInt(value: unknown): ValidationResult<number> {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, error: 'Expected a positive integer' };
  }
  return { ok: true, value: num };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and normalize whitespace.
 * This is a defence-in-depth measure; the primary XSS protection is React's
 * built-in escaping when rendering user-supplied strings.
 */
export function sanitizeText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/[^\S\n]+/g, ' ') // collapse horizontal whitespace
    .trim();
}

/**
 * Validate a Telegram chatId: must be a non-zero integer.
 * Telegram user IDs are positive; group/channel IDs are negative.
 */
export function validateChatId(value: unknown): ValidationResult<number> {
  const num = Number(value);
  if (!Number.isInteger(num) || num === 0) {
    return { ok: false, error: 'Invalid chatId — must be a non-zero integer' };
  }
  return { ok: true, value: num };
}

/** Validate an ISO 8601 date string. */
export function validateISODate(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'Expected a string' };
  const d = new Date(value);
  if (isNaN(d.getTime())) return { ok: false, error: 'Invalid date string' };
  return { ok: true, value: value };
}

/** Validate a transaction amount: positive finite number up to 1 billion. */
export function validateAmount(value: unknown): ValidationResult<number> {
  return validateNumber(value, { min: 0.01, max: 1_000_000_000 });
}
