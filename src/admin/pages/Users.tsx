import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

interface User {
  uid: string;
  displayName: string;
  email: string;
  telegramId: string;
  username: string;
  status: string;
  isPro: boolean;
  plan: string;
  subExpiresAt: string;
  referralCode: string;
  createdAt: string;
}

interface UsersData {
  users: User[];
  total: number;
  hasMore: boolean;
}

interface GrantModalState {
  userId: string;
  plan: string;
  periodMonths: number;
}

interface MsgModalState {
  userId: string;
  name: string;
  text: string;
}

interface DebugResult {
  ok: boolean;
  collectionSize: number;
  sample: { id: string; fields: string[] }[];
}

export default function Users() {
  const [search, setSearch] = useState('');
  const [searchApplied, setSearchApplied] = useState('');

  const { data, loading, error, refetch } = useAdminApi<UsersData>('adminUsers', { search: searchApplied, limit: 200 });
  const { toast } = useToast();
  const [debugInfo, setDebugInfo] = useState<DebugResult | null>(null);

  async function runDebug() {
    try {
      const res = await adminCall<DebugResult>('adminUsers', { action: 'debug' });
      setDebugInfo(res);
    } catch (e: unknown) {
      toast(`Ошибка диагностики: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  const [grantModal, setGrantModal] = useState<GrantModalState | null>(null);
  const [msgModal,   setMsgModal]   = useState<MsgModalState | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function blockUser(userId: string, block: boolean) {
    try {
      await adminCall('adminUsers', { action: block ? 'block' : 'unblock', userId });
      toast(block ? 'Пользователь заблокирован' : 'Разблокирован', block ? 'warn' : 'success');
      refetch();
    } catch { toast('Ошибка', 'error'); }
  }

  async function grantSub() {
    if (!grantModal) return;
    setActionLoading(true);
    try {
      await adminCall('adminUsers', { action: 'grant_subscription', userId: grantModal.userId, plan: grantModal.plan, periodMonths: grantModal.periodMonths });
      toast('Подписка выдана', 'success');
      setGrantModal(null);
      refetch();
    } catch { toast('Ошибка', 'error'); }
    finally { setActionLoading(false); }
  }

  async function sendMessage() {
    if (!msgModal?.text) return;
    setActionLoading(true);
    try {
      const res = await adminCall<{ ok: boolean; error?: string }>('adminUsers', { action: 'send_message', userId: msgModal.userId, text: msgModal.text });
      if (res.ok) toast('Сообщение отправлено', 'success');
      else toast(`Ошибка: ${res.error}`, 'error');
      setMsgModal(null);
    } catch { toast('Ошибка', 'error'); }
    finally { setActionLoading(false); }
  }

  const columns: Column<User>[] = [
    { key: 'displayName', label: 'Имя' },
    { key: 'telegramId',  label: 'Telegram',   render: r => r.telegramId  ? <span className="adm-mono">{r.telegramId}</span>   : <span style={{ color: 'var(--muted)' }}>—</span> },
    { key: 'username',    label: 'Username',   render: r => r.username    ? <span className="adm-mono">@{r.username}</span>    : <span style={{ color: 'var(--muted)' }}>—</span> },
    { key: 'email',       label: 'Email',      render: r => r.email       ? <span style={{ fontSize: 12 }}>{r.email}</span>    : <span style={{ color: 'var(--muted)' }}>—</span> },
    { key: 'plan', label: 'Тариф', render: r => {
        const p = r.plan || 'free';
        if (p === 'premium') return <span className="adm-badge yellow">Premium</span>;
        if (p === 'pro')     return <span className="adm-badge purple">Pro</span>;
        return <span className="adm-badge gray">Free</span>;
    }},
    { key: 'subExpiresAt', label: 'Истекает', render: r => {
        if (!r.subExpiresAt) return <span style={{ color: 'var(--muted)' }}>—</span>;
        const d = new Date(r.subExpiresAt);
        const expired = d < new Date();
        return <span style={{ color: expired ? 'var(--red)' : 'var(--green)', fontSize: 12 }}>{d.toISOString().slice(0, 10)}</span>;
    }},
    { key: 'referralCode', label: 'Реферал', render: r => r.referralCode ? <span className="adm-mono" style={{ color: '#c4b5fd' }}>{r.referralCode}</span> : <span style={{ color: 'var(--muted)' }}>—</span> },
    { key: 'status', label: 'Статус', render: r => r.status === 'blocked'
        ? <span className="adm-badge red">Заблокирован</span>
        : <span className="adm-badge green">Активен</span>
    },
    { key: 'createdAt', label: 'Регистрация', render: r => r.createdAt ? r.createdAt.slice(0, 10) : '—' },
    { key: 'actions', label: '', sortable: false, render: r => (
      <div className="adm-row-actions">
        <button className="adm-btn ghost sm" onClick={() => setGrantModal({ userId: r.uid, plan: 'pro', periodMonths: 1 })}>
          + Подписка
        </button>
        <button className="adm-btn ghost sm" onClick={() => setMsgModal({ userId: r.uid, name: r.displayName, text: '' })}>
          Сообщение
        </button>
        <button
          className={`adm-btn sm ${r.status === 'blocked' ? 'success' : 'danger'}`}
          onClick={() => blockUser(r.uid, r.status !== 'blocked')}
        >
          {r.status === 'blocked' ? 'Разблокировать' : 'Блок'}
        </button>
      </div>
    )},
  ];

  return (
    <>
      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">Пользователи {data ? `(${data.total ?? data.users.length})` : ''}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="adm-btn ghost sm" onClick={runDebug} title="Диагностика Firestore">Диагностика</button>
            <button className="adm-btn ghost sm" onClick={refetch}>Обновить</button>
          </div>
          <div className="adm-search">
            <input
              className="adm-input adm-search-input"
              placeholder="Поиск по имени, email, ID..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') setSearchApplied(search); }}
            />
            <button className="adm-btn primary" onClick={() => setSearchApplied(search)}>Найти</button>
            {searchApplied && <button className="adm-btn ghost" onClick={() => { setSearch(''); setSearchApplied(''); }}>✕</button>}
          </div>
        </div>
        <DataTable<User>
          columns={columns}
          rows={data?.users || []}
          loading={loading}
          rowKey={r => r.uid}
          emptyText={error || 'Нет пользователей'}
          pageSize={50}
        />
      </div>

      {debugInfo && (
        <div className="adm-table-card" style={{ marginTop: 16, padding: 16, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Диагностика Firestore — найдено документов: <b>{debugInfo.collectionSize}</b>
            {debugInfo.collectionSize === 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>⚠ Коллекция пуста!</span>}
          </div>
          {debugInfo.sample.map(doc => (
            <div key={doc.id} style={{ marginBottom: 4, fontFamily: 'monospace', color: 'var(--muted)' }}>
              <b style={{ color: 'var(--text)' }}>{doc.id}</b> — поля: {doc.fields.join(', ')}
            </div>
          ))}
          <button className="adm-btn ghost sm" style={{ marginTop: 8 }} onClick={() => setDebugInfo(null)}>Закрыть</button>
        </div>
      )}

      {grantModal && (
        <Modal
          title="Выдать подписку"
          onClose={() => setGrantModal(null)}
          footer={
            <>
              <button className="adm-btn ghost" onClick={() => setGrantModal(null)}>Отмена</button>
              <button className="adm-btn primary" onClick={grantSub} disabled={actionLoading}>
                {actionLoading ? 'Выдаётся...' : 'Выдать'}
              </button>
            </>
          }
        >
          <div className="adm-form-row">
            <label className="adm-label">Тариф</label>
            <select className="adm-select" value={grantModal.plan} onChange={e => setGrantModal(p => p ? { ...p, plan: e.target.value } : p)}>
              <option value="pro">Pro</option>
              <option value="premium">Premium</option>
            </select>
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Период (месяцев)</label>
            <input
              className="adm-input"
              type="number"
              min={1}
              max={24}
              value={grantModal.periodMonths}
              onChange={e => setGrantModal(p => p ? { ...p, periodMonths: Number(e.target.value) } : p)}
            />
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            User ID: <span className="adm-mono">{grantModal.userId}</span>
          </div>
        </Modal>
      )}

      {msgModal && (
        <Modal
          title={`Сообщение — ${msgModal.name || msgModal.userId}`}
          onClose={() => setMsgModal(null)}
          footer={
            <>
              <button className="adm-btn ghost" onClick={() => setMsgModal(null)}>Отмена</button>
              <button className="adm-btn primary" onClick={sendMessage} disabled={actionLoading || !msgModal.text}>
                {actionLoading ? 'Отправка...' : 'Отправить'}
              </button>
            </>
          }
        >
          <div className="adm-form-row">
            <label className="adm-label">Текст (поддерживается HTML)</label>
            <textarea
              className="adm-textarea"
              rows={5}
              value={msgModal.text}
              onChange={e => setMsgModal(p => p ? { ...p, text: e.target.value } : p)}
              placeholder="Введите текст сообщения..."
            />
          </div>
        </Modal>
      )}
    </>
  );
}
