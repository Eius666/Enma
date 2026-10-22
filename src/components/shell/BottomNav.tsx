import React from 'react';
import { FaSun, FaCalendarAlt, FaStickyNote, FaChartLine, FaCheckCircle } from 'react-icons/fa';
import type { PrimaryTab } from '../../types/app';

interface Props {
  language: string;
  activeTab: PrimaryTab;
  onSelect: (tab: PrimaryTab) => void;
}

// Bottom navigation bar (5 tabs; Settings is reached via the header gear).
export function BottomNav({ language, activeTab, onSelect }: Props): React.ReactElement {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {([
        { id: 'day-flow',  icon: <FaSun />,         label: language === 'ru' ? 'День'      : 'Day'      },
        { id: 'calendar',  icon: <FaCalendarAlt />,  label: language === 'ru' ? 'Календарь' : 'Calendar' },
        { id: 'notes',     icon: <FaStickyNote />,   label: language === 'ru' ? 'Заметки'   : 'Notes'    },
        { id: 'finance',   icon: <FaChartLine />,    label: language === 'ru' ? 'Финансы'   : 'Finance'  },
        { id: 'habits',    icon: <FaCheckCircle />,  label: language === 'ru' ? 'Привычки'  : 'Habits'   },
      ] as const).map(tab => (
        <button
          key={tab.id}
          className={`bottom-nav__item${activeTab === tab.id ? ' bottom-nav__item--active' : ''}`}
          onClick={() => onSelect(tab.id)}
          type="button"
        >
          {/* SVG icon — no emoji */}
          <span className="bottom-nav__icon">{tab.icon}</span>
          <span className="bottom-nav__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
