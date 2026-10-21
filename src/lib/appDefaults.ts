import type { Category, Language, NoteProject } from '../types/app';

// Default categories / note projects used before the user has any of their own.
// Moved out of App.tsx unchanged.

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'cat-salary', name: 'Salary', type: 'income' },
  { id: 'cat-freelance', name: 'Freelance', type: 'income' },
  { id: 'cat-food', name: 'Food', type: 'expense' },
  { id: 'cat-software', name: 'Software', type: 'expense' }
];

export const getDefaultCategories = (language: Language): Category[] => {
  if (language === 'ru') {
    return [
      { id: 'cat-salary', name: 'Зарплата', type: 'income' },
      { id: 'cat-freelance', name: 'Фриланс', type: 'income' },
      { id: 'cat-food', name: 'Еда', type: 'expense' },
      { id: 'cat-software', name: 'Софт', type: 'expense' }
    ];
  }
  return DEFAULT_CATEGORIES;
};

export const getDefaultNoteProjects = (language: Language): NoteProject[] => [
  {
    id: 'project-default',
    name: language === 'ru' ? 'Общее' : 'General'
  }
];
