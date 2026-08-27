import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

interface Sub {
  userId: string;
  plan: string;
  period: string;
  status: string;
  endDate: string;
  endDateMs: number;
  paymentMethod: string;
  promoCode: string;
  referralCode: string;
  grantedByAdmin: boolean;
  updatedAt: string;
}

interface SubsData { subscriptions: Sub[] }

export default function Subscriptions() {
  const { data, loading, error, refetch } = useAdminApi<SubsData>('adminSubscriptions', {});
  const { toast } = useToast();
  const [modal, setModal] = useState<Sub | null>(null);
  const [plan, setPlan]   = useState('pro');
  const [months, setMonths] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  function openEdit(sub: Sub) {
    setModal(sub);
    setPlan(sub.plan || 'pro');
    setMonths(1);
  }

  async function handleUpdate(action: string) {
    if (!modal) return;
    setSubmitting(true);
    try {
      await adminCall('adminSubscriptions', { action: 'update', userId: modal.userId, plan, periodMonths: months, status: action === 'cancel' ? 'cancelled' : undefined });
      toast(action === 'cancel' ? 'Подписка отменена' : 'Обновлено', action === 'cancel' ? 'warn' : 'success');
      setModal(null);
      refetch();
    } catch { toast('Ошибка', 'error'); }
    finally { setSubmitting(false); }
  }

  function statusBadge(sub: Sub) {
    if (sub.status === 'cancelled') return <span className="adm-badge red">Отменена</span>;
    const expired = sub.endDateMs && sub.endDateMs < Date.now();
    if (expired) return <span className="adm-badge yellow">Истекла</span>;
    return <span className="adm-badge green">Активна</span>;
  }

  const columns: Column<Sub>[] = [
    { key: 'userId',      label: 'User ID', render: r => <span className="adm-mono" style={{ fontSize: 11 }}>{r.userId.slice(0, 12)}...</span> },
    { key: 'plan',        label: 'Тариф',   render: r => <span className="adm-badge purple">{r.plan || '—'}</span> },
    { key: 'period',      label: 'Период' },
    { key: 'status',      label: 'Статус',  render: r => statusBadge(r) },
    { key: 'endDate',     label: 'Истекает',render: r => r.endDate ? r.endDate.slice(0, 10) : '—' },
    { key: 'paymentMethod', label: 'Метод' },
    { key: 'promoCode',   label: 'Промо',   render: r => r.promoCode || r.referralCode
        ? <span className="adm-mono">{r.promoCode || r.referralCode}</span>
        : <span style={{ color: 'var(--muted)' }}>—</span>
    },
    { key: 'grantedByAdmin', label: 'Источник', render: r => r.grantedByAdmin
        ? <span className="adm-badge yellow">Администратор</span>
        : <span className="adm-badge gray">Органика</span>
    },
    { key: 'actions', label: '', sortable: false, render: r => (
      <button className="adm-btn ghost sm" onClick={() => openEdit(r)}>Изменить</button>
    )},
  ];

  return (
    <>
      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">Подписки {data ? `(${data.subscriptions.length})` : ''}</span>
          <button className="adm-btn ghost" onClick={refetch}>Обновить</button>
        </div>
        <DataTable<Sub>
          columns={columns}
          rows={data?.subscriptions || []}
          loading={loading}
          rowKey={r => r.userId}
          emptyText={error || 'Нет подписок'}
          pageSize={50}
        />
      </div>

      {modal && (
        <Modal
          title={`Изменить подписку — ${modal.userId.slice(0, 12)}...`}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="adm-btn danger" onClick={() => handleUpdate('cancel')} disabled={submitting}>Отменить подписку</button>
              <button className="adm-btn ghost" onClick={() => setModal(null)}>Закрыть</button>
              <button className="adm-btn primary" onClick={() => handleUpdate('update')} disabled={submitting}>Сохранить</button>
            </>
          }
        >
          <div className="adm-form-row">
            <label className="adm-label">Тариф</label>
            <select className="adm-select" value={plan} onChange={e => setPlan(e.target.value)}>
              <option value="pro">Pro</option>
              <option value="premium">Premium</option>
            </select>
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Добавить месяцев (0 — не изменять)</label>
            <input className="adm-input" type="number" min={0} max={24} value={months} onChange={e => setMonths(Number(e.target.value))} />
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Текущий тариф: <b>{modal.plan}</b>, истекает: <b>{modal.endDate ? modal.endDate.slice(0, 10) : '—'}</b>
          </div>
        </Modal>
      )}
    </>
  );
}
