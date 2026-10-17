import type { User } from 'firebase/auth';

// Headers for calls to the protected backend (payment API).
// The Firebase ID token is fetched per request (the SDK caches and refreshes it)
// and is never stored, logged or put in a URL. If no token can be obtained this
// throws, so the caller never sends a request without credentials.
export async function authedJsonHeaders(user: User): Promise<Record<string, string>> {
  const token = await user.getIdToken();
  if (!token) throw new Error('auth_token_unavailable');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

// Friendly text for 401/403 from the protected backend; null for other statuses.
export function authFailureMessage(status: number, language: string): string | null {
  if (status !== 401 && status !== 403) return null;
  return language === 'ru'
    ? 'Не удалось подтвердить сессию. Закройте и снова откройте приложение.'
    : 'Could not verify your session. Please close and reopen the app.';
}
