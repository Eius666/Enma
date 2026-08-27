import { useState } from 'react';
import { adminCall, setAdminKey } from './hooks/useAdminApi';

interface LoginProps {
  onLogin: () => void;
}

type Step = 'key' | 'otp';

interface OtpResult {
  ok: boolean;
  required: boolean;
  error?: string | null;
}

export default function Login({ onLogin }: LoginProps) {
  const [step, setStep]       = useState<Step>('key');
  const [key, setKey]         = useState('');
  const [otp, setOtp]         = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  async function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    setError('');
    try {
      setAdminKey(key.trim());
      // Check if TOTP is configured
      const res = await adminCall<OtpResult>('adminVerifyOtp', {});
      if (!res.required) {
        // No 2FA configured — log in immediately
        onLogin();
      } else {
        // 2FA required — show OTP step
        setStep('otp');
      }
    } catch {
      setError('Неверный ключ доступа');
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!otp.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminCall<OtpResult>('adminVerifyOtp', { token: otp.trim() });
      if (res.ok) {
        sessionStorage.setItem('admin_otp_verified', '1');
        onLogin();
      } else {
        setError('Неверный код. Убедитесь что время устройства синхронизировано.');
        setOtp('');
      }
    } catch {
      setError('Ошибка проверки кода');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="adm-login-screen">
      <div className="adm-login-card">
        <div className="adm-login-logo">{step === 'key' ? '⚙' : '🔐'}</div>

        {step === 'key' ? (
          <>
            <div className="adm-login-title">Enma Admin</div>
            <div className="adm-login-sub">Введите ключ администратора</div>
            <form className="adm-login-form" onSubmit={handleKeySubmit}>
              <div className="adm-form-row">
                <label className="adm-label">Admin API Key</label>
                <input
                  className="adm-input"
                  type="password"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  placeholder="••••••••••••••••"
                  autoFocus
                  autoComplete="current-password"
                />
              </div>
              <button
                className="adm-btn primary adm-login-btn"
                type="submit"
                disabled={loading || !key.trim()}
              >
                {loading ? 'Проверка...' : 'Продолжить'}
              </button>
              {error && <div className="adm-login-error">{error}</div>}
            </form>
          </>
        ) : (
          <>
            <div className="adm-login-title">Двухфакторная аутентификация</div>
            <div className="adm-login-sub">
              Введите 6-значный код из Google Authenticator
            </div>
            <form className="adm-login-form" onSubmit={handleOtpSubmit}>
              <div className="adm-form-row">
                <label className="adm-label">Код подтверждения</label>
                <input
                  className="adm-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  autoFocus
                  autoComplete="one-time-code"
                  style={{ letterSpacing: '0.25em', fontSize: 20, textAlign: 'center' }}
                />
              </div>
              <button
                className="adm-btn primary adm-login-btn"
                type="submit"
                disabled={loading || otp.length !== 6}
              >
                {loading ? 'Проверка...' : 'Войти'}
              </button>
              <button
                type="button"
                className="adm-btn ghost adm-login-btn"
                style={{ marginTop: 8 }}
                onClick={() => { setStep('key'); setOtp(''); setError(''); }}
              >
                ← Назад
              </button>
              {error && <div className="adm-login-error">{error}</div>}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
