import React, { useState } from 'react';
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
  { path: '/admin/2fa-setup',     icon: '⊛', label: 'Настройка 2FA' },
];

interface LayoutProps {
  children: React.ReactNode;
  currentPath: string;
  navigate: (path: string) => void;
  pageTitle: string;
}

export default function Layout({ children, currentPath, navigate, pageTitle }: LayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  function handleLogout() {
    clearAdminKey();
    window.location.reload();
  }

  function handleNav(path: string) {
    navigate(path);
    setDrawerOpen(false);
  }

  return (
    <div className="adm-shell">
      {/* Overlay — closes drawer on tap */}
      {drawerOpen && (
        <div className="adm-drawer-overlay" onClick={() => setDrawerOpen(false)} />
      )}

      <aside className={`adm-sidebar ${drawerOpen ? 'adm-sidebar--open' : ''}`}>
        <div className="adm-logo">
          <h1>Enma</h1>
          <span>Admin Dashboard</span>
        </div>
        <nav className="adm-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.path}
              className={`adm-nav-item ${currentPath === item.path ? 'active' : ''}`}
              onClick={() => handleNav(item.path)}
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
          <div className="adm-topbar-left">
            <button
              className="adm-hamburger"
              onClick={() => setDrawerOpen(o => !o)}
              aria-label="Меню"
            >
              <span /><span /><span />
            </button>
            <span className="adm-topbar-title">{pageTitle}</span>
          </div>
          <span className="adm-topbar-meta">Enma Admin</span>
        </div>
        <div className="adm-page">
          {children}
        </div>
      </main>
    </div>
  );
}
