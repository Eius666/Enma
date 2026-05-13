export interface UserProfile {
  id: string;
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  language?: string;
  createdAt: number;
  updatedAt: number;
}
