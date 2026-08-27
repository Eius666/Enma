import React from 'react';
import { clearAdminKey } from './hooks/useAdminApi';

const NAV_ITEMS = [
  { path: '/admin',               icon: '◈', label: 'Обзор'         },
  { path: '/admin/users',         icon: '◉', label: 'Пользователи'  },
  { path: '/admin/subscriptions', icon: '◎', label: 'Подписки'      },
  { path: '/admin/payments',      icon: '◇', label: 'Платежи'       },
  { path: '/admin/referrals',     icon: '◈', label: 'Рефералы'      },
  { path: '/admin/promocodes',    icon: '◆', label: 'Промокоды'     },
  { path: '/admin/messages',      icon: '◉', label: 'Рассылка'      },
  { path: '/admin/ai-usage',      icon: '◌', label: 'AI-расходы'    },
];

interface LayoutProps {
  children: React.ReactNode;
  currentPath: string;
  navigate: (path: string) => void;
  pageTitle: string;
}

export default function Layout({ children, currentPath, navigate, pageTitle }: LayoutProps) {
  function handleLogout() {
    clearAdminKey();
    window.location.reload();
  }

  return (
    <div className="adm-shell">
      <aside className="adm-sidebar">
        <div className="adm-logo">
          <h1>Enma</h1>
          <span>Admin Dashboard</span>
        </div>
        <nav className="adm-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.path}
              className={`adm-nav-item ${currentPath === item.path ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="adm-nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="adm-sidebar-footer">
          <button className="adm-logout" onClick={handleLogout}>
            <span className="adm-nav-icon">⊗</span>
            Выйти
          </button>
        </div>
      </aside>

      <main className="adm-main">
        <div className="adm-topbar">
          <span className="adm-topbar-title">{pageTitle}</span>
          <span className="adm-topbar-meta">Enma Admin v1</span>
        </div>
        <div className="adm-page">
          {children}
        </div>
      </main>
    </div>
  );
}
