import { useMemo } from 'react';
import { format, addDays } from 'date-fns';
import type { DayTask } from '../components/DayList';

export interface WeekDayGroup {
  dateKey: string;
  tasks: DayTask[];
}

export function useWeekTasks(tasks: DayTask[]): {
  weekGroups: WeekDayGroup[];
  hasWeekTasks: boolean;
} {
  return useMemo(() => {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const dayKeys: string[] = [];
    for (let i = 1; i <= 6; i++) {
      dayKeys.push(format(addDays(todayMidnight, i), 'yyyy-MM-dd'));
    }

    const keySet = new Set(dayKeys);
    const grouped: Record<string, DayTask[]> = {};

    for (const task of tasks) {
      if (keySet.has(task.date)) {
        if (!grouped[task.date]) grouped[task.date] = [];
        grouped[task.date].push(task);
      }
    }

    const weekGroups = dayKeys
      .filter(key => !!grouped[key])
      .map(key => ({ dateKey: key, tasks: grouped[key] }));

    return {
      weekGroups,
      hasWeekTasks: weekGroups.length > 0,
    };
  }, [tasks]);
}
