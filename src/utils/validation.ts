const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Return true if the string looks like a valid email address. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Return true if the string can be parsed as a positive finite number. */
export function isValidAmount(value: string): boolean {
  const num = parseFloat(value);
  return !isNaN(num) && isFinite(num) && num > 0;
}

/** Return true if the string is a parseable date (ISO or Date constructor). */
export function isValidDate(date: string): boolean {
  if (!date) return false;
  const d = new Date(date);
  return !isNaN(d.getTime());
}

/** Return true if the string is non-empty after trimming. */
export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/** Return true if a password meets the minimum length requirement. */
export function isValidPassword(password: string, minLength: number = 6): boolean {
  return password.length >= minLength;
}
