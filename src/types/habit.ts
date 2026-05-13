export interface Habit {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  icon?: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  target: number;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HabitLog {
  id: string;
  habitId: string;
  date: string; // YYYY-MM-DD
  value: number;
  createdAt: number;
}
