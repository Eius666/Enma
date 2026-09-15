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
  en: { heading: 'UPCOMING' },
  ru: { heading: 'ПРЕДСТОЯЩИЕ' },
};

const WeekSummary: React.FC<WeekSummaryProps> = ({ language, weekGroups, hasWeekTasks }) => {
  if (!hasWeekTasks) return null;

  const t = T[language];
  const locale = language === 'ru' ? ruLocale : enUS;

  return (
    <div className="week-summary">
      <div className="week-summary__heading">{t.heading}</div>

      {weekGroups.map(({ dateKey, tasks }) => {
        const date = parseISO(dateKey);
        const dayLabel = format(date, 'EEEE, d MMMM', { locale });
        const capitalized = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);

        return (
          <div key={dateKey} className="week-summary__group">
            <div className="week-summary__day-label">{capitalized}</div>

            {tasks.map(task => (
              <div key={task.id} className="week-summary__item">
                <span
                  className="week-summary__item-priority"
                  style={{ backgroundColor: PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium }}
                />
                <span className="week-summary__item-title">{task.title}</span>
                {task.time && (
                  <span className="week-summary__item-time">{task.time}</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

export default WeekSummary;
