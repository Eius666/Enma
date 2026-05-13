export interface Note {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  content: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}
