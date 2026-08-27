import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import { useToast } from '../components/Toast';

interface SetupData {
  ok: boolean;
  secret: string;
  uri: string;
  alreadyConfigured: boolean;
}

interface TestResult {
  ok: boolean;
  error?: string | null;
}

export default function Setup2FA() {
  const { data, loading } = useAdminApi<SetupData>('adminSetupOtp', {});
  const { toast } = useToast();

  const [testCode, setTestCode] = useState('');
  const [testing,  setTesting]  = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

  async function handleTest() {
    if (!data?.secret || testCode.length !== 6) return;
    setTesting(true);
    try {
      const res = await adminCall<TestResult>('adminSetupOtp', {
        testToken:       testCode,
        candidateSecret: data.secret,
      });
      setTestResult(res.ok);
      if (res.ok) toast('Код верный — 2FA работает!', 'success');
      else        toast('Неверный код. Проверьте что время синхронизировано.', 'error');
    } catch {
      toast('Ошибка проверки', 'error');
    } finally {
      setTesting(false);
      setTestCode('');
    }
  }

  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => toast(`${label} скопирован`, 'success'));
  }

  if (loading) return <div className="adm-loading">Загрузка...</div>;
  if (!data)   return <div className="adm-empty">Ошибка загрузки</div>;

  const qrUrl = `https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encodeURIComponent(data.uri)}`;

  return (
    <div style={{ maxWidth: 640 }}>
      {data.alreadyConfigured ? (
        <div className="adm-table-card" style={{ marginBottom: 20, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 10 }}>
          <span style={{ fontSize: 20 }}>✓</span>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--green)' }}>2FA активна</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              ADMIN_TOTP_SECRET уже задан в Vercel. Страница входа требует 6-значный код.
            </div>
          </div>
        </div>
      ) : (
        <div className="adm-table-card" style={{ marginBottom: 20, padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10 }}>
          <span style={{ fontSize: 20 }}>!</span>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--yellow)' }}>2FA не настроена</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              Выполни шаги ниже, добавь ADMIN_TOTP_SECRET в Vercel и сделай Redeploy.
            </div>
          </div>
        </div>
      )}

      <div className="adm-table-card" style={{ marginBottom: 20 }}>
        <div className="adm-table-header">
          <span className="adm-table-title">Шаг 1 — Добавить в Google Authenticator</span>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div className="adm-label" style={{ marginBottom: 10 }}>QR-код</div>
              <img
                src={qrUrl}
                alt="QR code"
                width={180}
                height={180}
                style={{ borderRadius: 8, background: '#fff', padding: 8, display: 'block' }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
                Отсканируй в Google Authenticator
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="adm-form-row">
                <label className="adm-label">Или введи ключ вручную</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      padding: '10px 14px',
                      borderRadius: 6,
                      fontSize: 15,
                      letterSpacing: '0.12em',
                      fontFamily: 'monospace',
                      flex: 1,
                      wordBreak: 'break-all',
                    }}
                  >
                    {data.secret}
                  </code>
                  <button className="adm-btn ghost" onClick={() => copyText(data.secret, 'Секрет')}>
                    Копировать
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                В Google Authenticator:
                <ol style={{ marginLeft: 18, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <li>Нажми <b>+</b> → «Ввести ключ настройки»</li>
                  <li>Название: <b>Enma Admin</b></li>
                  <li>Ключ: вставь секрет выше</li>
                  <li>Тип: <b>Временной</b></li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="adm-table-card" style={{ marginBottom: 20 }}>
        <div className="adm-table-header">
          <span className="adm-table-title">Шаг 2 — Добавить в Vercel</span>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.6 }}>
            Vercel Dashboard → Settings → Environment Variables → добавь переменную:
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div className="adm-label">Имя переменной</div>
              <code style={{ background: 'rgba(255,255,255,0.06)', padding: '8px 12px', borderRadius: 6, fontSize: 13, display: 'block', fontFamily: 'monospace' }}>ADMIN_TOTP_SECRET</code>
            </div>
            <div style={{ flex: 2 }}>
              <div className="adm-label">Значение</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <code style={{ background: 'rgba(255,255,255,0.06)', padding: '8px 12px', borderRadius: 6, fontSize: 13, display: 'block', fontFamily: 'monospace', flex: 1, wordBreak: 'break-all' }}>
                  {data.secret}
                </code>
                <button className="adm-btn ghost" onClick={() => copyText(`ADMIN_TOTP_SECRET=${data.secret}`, 'Переменная')}>
                  Копировать
                </button>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--yellow)', marginTop: 10 }}>
            После добавления переменной нажми <b>Redeploy</b> в Vercel — иначе изменения не применятся.
          </div>
        </div>
      </div>

      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">Шаг 3 — Проверить код</span>
        </div>
        <div style={{ padding: 20 }}>
          <div className="adm-form-row">
            <label className="adm-label">Введи 6-значный код из Google Authenticator</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                className="adm-input"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={testCode}
                onChange={e => { setTestCode(e.target.value.replace(/\D/g, '')); setTestResult(null); }}
                placeholder="000000"
                style={{ maxWidth: 140, letterSpacing: '0.2em', fontSize: 18, textAlign: 'center' }}
              />
              <button
                className="adm-btn primary"
                onClick={handleTest}
                disabled={testing || testCode.length !== 6}
              >
                {testing ? 'Проверка...' : 'Проверить'}
              </button>
              {testResult !== null && (
                <span style={{ color: testResult ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                  {testResult ? '✓ Верно' : '✕ Неверно'}
                </span>
              )}
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
            Если код верный — настройка завершена. 2FA начнёт работать после Redeploy.
          </div>
        </div>
      </div>
    </div>
  );
}
