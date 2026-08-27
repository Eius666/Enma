import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import { useToast } from '../components/Toast';

interface MsgRecord {
  id: string;
  text: string;
  target: string;
  total: number;
  sent: number;
  failed: number;
  sentAt: string;
}

interface HistoryData { messages: MsgRecord[] }

const TARGETS = [
  { value: 'all',     label: 'Все пользователи' },
  { value: 'free',    label: 'Free пользователи' },
  { value: 'pro',     label: 'Pro подписчики' },
  { value: 'premium', label: 'Premium подписчики' },
];

export default function Messages() {
  const [text,   setText]   = useState('');
  const [target, setTarget] = useState('all');
  const [customIds, setCustomIds] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [sending,   setSending]   = useState(false);
  const [lastResult, setLastResult] = useState<{ total: number; sent: number; failed: number } | null>(null);

  const { data: history, loading: histLoading, refetch } = useAdminApi<HistoryData>('adminMessages', { action: 'history' });
  const { toast } = useToast();

  async function handleSend() {
    if (!text.trim()) return;
    const confirmed = window.confirm(`Отправить сообщение выбранной аудитории?\n\n"${text.slice(0, 100)}..."`);
    if (!confirmed) return;

    setSending(true);
    setLastResult(null);
    try {
      const payload = useCustom
        ? { text, target: customIds.split('\n').map(s => s.trim()).filter(Boolean) }
        : { text, target };
      const res = await adminCall<{ ok: boolean; total: number; sent: number; failed: number }>('adminMessages', payload);
      setLastResult({ total: res.total, sent: res.sent, failed: res.failed });
      toast(`Отправлено ${res.sent}/${res.total}`, res.failed > 0 ? 'warn' : 'success');
      refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Ошибка';
      toast(msg, 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="adm-table-card" style={{ marginBottom: 24 }}>
        <div className="adm-table-header">
          <span className="adm-table-title">Новая рассылка</span>
        </div>
        <div style={{ padding: 20 }}>
          <div className="adm-form-row">
            <label className="adm-label">Аудитория</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={useCustom} onChange={e => setUseCustom(e.target.checked)} />
                По списку User ID
              </label>
            </div>
            {useCustom ? (
              <textarea
                className="adm-textarea"
                rows={4}
                value={customIds}
                onChange={e => setCustomIds(e.target.value)}
                placeholder="Один User ID на строку..."
              />
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {TARGETS.map(t => (
                  <button
                    key={t.value}
                    className={`adm-btn ${target === t.value ? 'primary' : 'ghost'}`}
                    onClick={() => setTarget(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="adm-form-row">
            <label className="adm-label">Текст сообщения (поддерживается HTML)</label>
            <textarea
              className="adm-textarea"
              rows={7}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Введите текст рассылки..."
            />
          </div>

          {text && (
            <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
              <div style={{ color: 'var(--muted)', marginBottom: 6, fontSize: 11 }}>ПРЕДПРОСМОТР</div>
              <div dangerouslySetInnerHTML={{ __html: text.replace(/\n/g, '<br/>') }} />
            </div>
          )}

          {lastResult && (
            <div style={{ marginBottom: 16, padding: 12, background: 'rgba(34,197,94,0.08)', borderRadius: 8, fontSize: 13 }}>
              Результат: <b style={{ color: 'var(--green)' }}>{lastResult.sent} доставлено</b>
              {lastResult.failed > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>{lastResult.failed} ошибок</span>}
              <span style={{ color: 'var(--muted)', marginLeft: 8 }}>из {lastResult.total}</span>
            </div>
          )}

          <button
            className="adm-btn primary"
            onClick={handleSend}
            disabled={sending || !text.trim()}
            style={{ minWidth: 160 }}
          >
            {sending ? 'Отправка...' : 'Отправить рассылку'}
          </button>
        </div>
      </div>

      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">История рассылок</span>
          <button className="adm-btn ghost" onClick={refetch}>Обновить</button>
        </div>
        {histLoading ? (
          <div className="adm-loading">Загрузка...</div>
        ) : !history?.messages?.length ? (
          <div className="adm-empty">Рассылок ещё не было</div>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Аудитория</th>
                  <th>Всего</th>
                  <th>Доставлено</th>
                  <th>Ошибок</th>
                  <th>Текст</th>
                </tr>
              </thead>
              <tbody>
                {history.messages.map(m => (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{m.sentAt ? m.sentAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td><span className="adm-badge gray">{m.target}</span></td>
                    <td>{m.total}</td>
                    <td><span style={{ color: 'var(--green)' }}>{m.sent}</span></td>
                    <td>{m.failed > 0 ? <span style={{ color: 'var(--red)' }}>{m.failed}</span> : '—'}</td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: 12 }}>
                      {m.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
