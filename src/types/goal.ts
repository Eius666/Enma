export interface Goal {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  description?: string;
  deadline?: number;
  progress: number; // 0-100
  createdAt: number;
  updatedAt: number;
}
