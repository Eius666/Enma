import { useState, useEffect } from 'react';
import './admin.css';
import Login from './Login';
import Layout from './Layout';
import { ToastProvider } from './components/Toast';
import { getAdminKey } from './hooks/useAdminApi';

import Overview      from './pages/Overview';
import Users         from './pages/Users';
import Subscriptions from './pages/Subscriptions';
import Payments      from './pages/Payments';
import Referrals     from './pages/Referrals';
import PromoCodes    from './pages/PromoCodes';
import Messages      from './pages/Messages';
import AiUsage       from './pages/AiUsage';
import Setup2FA      from './pages/Setup2FA';

const ROUTES: Record<string, { title: string; component: React.ComponentType }> = {
  '/admin':               { title: 'Обзор',          component: Overview      },
  '/admin/users':         { title: 'Пользователи',   component: Users         },
  '/admin/subscriptions': { title: 'Подписки',       component: Subscriptions },
  '/admin/payments':      { title: 'Платежи',        component: Payments      },
  '/admin/referrals':     { title: 'Рефералы',       component: Referrals     },
  '/admin/promocodes':    { title: 'Промокоды',      component: PromoCodes    },
  '/admin/messages':      { title: 'Рассылка',       component: Messages      },
  '/admin/ai-usage':      { title: 'AI-расходы',     component: AiUsage       },
  '/admin/2fa-setup':     { title: 'Настройка 2FA',  component: Setup2FA      },
};

function getCurrentPath() {
  const p = window.location.pathname;
  return p.endsWith('/') && p !== '/' ? p.slice(0, -1) : p;
}

export default function AdminApp() {
  const [authed, setAuthed]       = useState(!!getAdminKey());
  const [currentPath, setCurrentPath] = useState(getCurrentPath);

  useEffect(() => {
    function handlePop() { setCurrentPath(getCurrentPath()); }
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  }

  if (!authed) {
    return (
      <ToastProvider>
        <Login onLogin={() => setAuthed(true)} />
      </ToastProvider>
    );
  }

  const route = ROUTES[currentPath] || ROUTES['/admin'];
  const Page  = route.component;

  return (
    <ToastProvider>
      <Layout currentPath={currentPath} navigate={navigate} pageTitle={route.title}>
        <Page />
      </Layout>
    </ToastProvider>
  );
}
