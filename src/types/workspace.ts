export type WorkspaceType = 'personal' | 'finance' | 'habits' | 'notes' | 'health' | 'goals';

export interface Workspace {
  id: string;
  userId: string;
  type: WorkspaceType;
  title: string;
  icon?: string;
  order: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
