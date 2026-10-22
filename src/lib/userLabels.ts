// How the signed-in user is named in the app shell (header greeting, avatar,
// the small identity line). Pure — derived from the stored profile, the
// Telegram user the Mini App reports (display only, never trusted for
// anything else) and the Firebase account e-mail.

export interface TelegramUserNames {
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface UserLabelsInput {
  profileDisplayName?: string | null;
  telegramUser?: TelegramUserNames | null;
  email?: string | null;
  fallbackName: string;
}

export interface UserLabels {
  /** "First Last", else the @username without "@"; undefined outside Telegram. */
  telegramName: string | undefined;
  /** Greeting / avatar source: profile name → Telegram name → e-mail local part → fallback. */
  displayName: string;
  /** Header nick: @username → Telegram first name → profile name → e-mail local part. */
  headerNick: string;
  /** The small identity line: e-mail → Telegram username → "—". */
  identityLine: string;
  /** First two letters of the display name, upper-cased. */
  avatarInitials: string;
}

export function deriveUserLabels({ profileDisplayName, telegramUser, email, fallbackName }: UserLabelsInput): UserLabels {
  const telegramName = telegramUser
    ? ([telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ') || telegramUser.username)
    : undefined;
  const emailName = email?.split('@')[0];

  const displayName = profileDisplayName || telegramName || emailName || fallbackName;

  const headerNick = telegramUser?.username
    ? `@${telegramUser.username}`
    : telegramUser?.first_name
    ? telegramUser.first_name
    : (profileDisplayName || emailName || '');

  const identityLine = email || telegramUser?.username || '—';

  return {
    telegramName,
    displayName,
    headerNick,
    identityLine,
    avatarInitials: displayName.slice(0, 2).toUpperCase(),
  };
}
