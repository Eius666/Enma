// The IANA time zone this device is set to ('Europe/Moscow'), or null when
// the runtime cannot tell (very old WebViews return nothing or 'UTC' only).
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : null;
  } catch {
    return null;
  }
}
