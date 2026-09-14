import React from 'react';
import { format, parseISO } from 'date-fns';
import { ru as ruLocale, enUS } from 'date-fns/locale';
import { PRIORITY_COLORS } from './DayList';
import type { WeekDayGroup } from '../hooks/useWeekTasks';

interface WeekSummaryProps {
  language: 'en' | 'ru';
  weekGroups: WeekDayGroup[];
  hasWeekTasks: boolean;
}

const T = {
  en: { heading: 'WEEK AHEAD' },
  ru: { heading: 'ЗАДАЧИ НА НЕДЕЛЮ' },
};

const MAX_DOTS = 5;

const WeekSummary: React.FC<WeekSummaryProps> = ({ language, weekGroups, hasWeekTasks }) => {
  if (!hasWeekTasks) return null;

  const t = T[language];
  const locale = language === 'ru' ? ruLocale : enUS;

  return (
    <div className="week-summary">
      <div className="week-summary__heading">{t.heading}</div>
      <div className="week-summary__scroll">
        {weekGroups.map(({ dateKey, tasks }) => {
          const date = parseISO(dateKey);
          const dayName = format(date, 'EEE', { locale }).toUpperCase();
          const dayNum = format(date, 'd');
          const count = tasks.length;
          const dots = tasks.slice(0, MAX_DOTS);
          const hasMore = count > MAX_DOTS;

          return (
            <div key={dateKey} className="week-day-card">
              <span className="week-day-name">{dayName}</span>
              <span className="week-day-num">{dayNum}</span>
              <span className="week-day-count">{count}</span>
              <div className="week-day-dots">
                {dots.map(task => (
                  <span
                    key={task.id}
                    className="week-day-dot"
                    style={{ backgroundColor: PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium }}
                  />
                ))}
                {hasMore && <span className="week-day-dot week-day-dot--more" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default WeekSummary;
