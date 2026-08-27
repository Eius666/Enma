import { useState } from 'react';
import { adminCall, setAdminKey } from './hooks/useAdminApi';

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [key, setKey]       = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    setError('');
    try {
      setAdminKey(key.trim());
      await adminCall('adminStats', {});
      onLogin();
    } catch {
      setError('Неверный ключ');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="adm-login-screen">
      <div className="adm-login-card">
        <div className="adm-login-logo">⚙</div>
        <div className="adm-login-title">Enma Admin</div>
        <div className="adm-login-sub">Введите ключ администратора</div>
        <form className="adm-login-form" onSubmit={handleSubmit}>
          <div className="adm-form-row">
            <label className="adm-label">Admin API Key</label>
            <input
              className="adm-input"
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="••••••••••••••••"
              autoFocus
            />
          </div>
          <button className="adm-btn primary adm-login-btn" type="submit" disabled={loading || !key.trim()}>
            {loading ? 'Проверка...' : 'Войти'}
          </button>
          {error && <div className="adm-login-error">{error}</div>}
        </form>
      </div>
    </div>
  );
}
