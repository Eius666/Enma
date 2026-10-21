// Shared day-task model and priority colours. Lives outside the components so
// that hooks and components can both depend on it without importing each other.

export interface DayTask {
  id: string;
  userId: string;
  title: string;
  description?: string;
  date: string;       // 'YYYY-MM-DD'
  time?: string | null; // 'HH:MM', null = no time
  priority: 'high' | 'medium' | 'low';
  completed: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** Priority indicator colours — CSS hex, used in list and editor (no emoji) */
export const PRIORITY_COLORS: Record<DayTask['priority'], string> = {
  high:   '#ff4757',
  medium: '#ffc107',
  low:    '#2ecc71',
};
