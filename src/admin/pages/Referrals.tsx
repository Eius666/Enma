import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

interface Referrer {
  id: string;
  name: string;
  commissionPercent: number;
  discountPercent: number;
  status: string;
  totalEarned: number;
  pendingPayout: number;
  paidOut: number;
  paymentDetails?: string;
}

interface Earning {
  id: string;
  referrerId: string;
  userId: string;
  amountPaid: number;
  commission: number;
  status: string;
  createdAt: string;
}

interface ReferralsData { referrers: Referrer[]; earnings: Earning[] }

export default function Referrals() {
  const { data, loading, error, refetch } = useAdminApi<ReferralsData>('adminReferrals', {});
  const { toast } = useToast();

  const [payoutModal, setPayoutModal] = useState<Referrer | null>(null);
  const [editModal,   setEditModal]   = useState<Referrer | null>(null);
  const [createModal, setCreateModal] = useState(false);
  const [payAmount,   setPayAmount]   = useState('');
  const [editForm,    setEditForm]    = useState({ commissionPercent: 30, discountPercent: 10, status: 'active', paymentDetails: '' });
  const [createForm,  setCreateForm]  = useState({ code: '', name: '', commissionPercent: 30, discountPercent: 10 });
  const [submitting,  setSubmitting]  = useState(false);

  async function handlePayout() {
    if (!payoutModal || !payAmount) return;
    setSubmitting(true);
    try {
      await adminCall('adminReferrals', { action: 'payout', referrerId: payoutModal.id, amount: Number(payAmount) });
      toast(`Выплачено ${payAmount} ₽`, 'success');
      setPayoutModal(null);
      refetch();
    } catch { toast('Ошибка', 'error'); }
    finally { setSubmitting(false); }
  }

  async function handleEdit() {
    if (!editModal) return;
    setSubmitting(true);
    try {
      await adminCall('adminReferrals', { action: 'update', referrerId: editModal.id, ...editForm });
      toast('Обновлено', 'success');
      setEditModal(null);
      refetch();
    } catch { toast('Ошибка', 'error'); }
    finally { setSubmitting(false); }
  }

  async function handleCreate() {
    if (!createForm.code || !createForm.name) return;
    setSubmitting(true);
    try {
      await adminCall('adminReferrals', { action: 'create', ...createForm });
      toast(`Инфлюенсер ${createForm.code} создан`, 'success');
      setCreateModal(false);
      setCreateForm({ code: '', name: '', commissionPercent: 30, discountPercent: 10 });
      refetch();
    } catch { toast('Ошибка', 'error'); }
    finally { setSubmitting(false); }
  }

  function openEdit(r: Referrer) {
    setEditModal(r);
    setEditForm({ commissionPercent: r.commissionPercent, discountPercent: r.discountPercent, status: r.status, paymentDetails: r.paymentDetails || '' });
  }

  const referrerCols: Column<Referrer>[] = [
    { key: 'id',   label: 'Код',  render: r => <span className="adm-mono" style={{ color: '#c4b5fd' }}>{r.id}</span> },
    { key: 'name', label: 'Имя' },
    { key: 'commissionPercent', label: 'Комиссия', render: r => `${r.commissionPercent}%` },
    { key: 'discountPercent',   label: 'Скидка',   render: r => `${r.discountPercent}%` },
    { key: 'status', label: 'Статус', render: r =>
        r.status === 'active'
          ? <span className="adm-badge green">Активен</span>
          : <span className="adm-badge red">Неактивен</span>
    },
    { key: 'totalEarned',  label: 'Заработано', render: r => `${(r.totalEarned || 0).toLocaleString()} ₽` },
    { key: 'pendingPayout',label: 'К выплате',  render: r =>
        (r.pendingPayout || 0) > 0
          ? <span className="adm-badge yellow">{(r.pendingPayout || 0).toLocaleString()} ₽</span>
          : <span style={{ color: 'var(--muted)' }}>0 ₽</span>
    },
    { key: 'paidOut', label: 'Выплачено', render: r => `${(r.paidOut || 0).toLocaleString()} ₽` },
    { key: 'actions', label: '', sortable: false, render: r => (
      <div className="adm-row-actions">
        {(r.pendingPayout || 0) > 0 && (
          <button className="adm-btn success sm" onClick={() => { setPayoutModal(r); setPayAmount(String(r.pendingPayout || '')); }}>
            Выплатить
          </button>
        )}
        <button className="adm-btn ghost sm" onClick={() => openEdit(r)}>Изменить</button>
      </div>
    )},
  ];

  const earningCols: Column<Earning>[] = [
    { key: 'referrerId', label: 'Инфлюенсер', render: r => <span className="adm-mono">{r.referrerId}</span> },
    { key: 'userId',     label: 'Покупатель',  render: r => <span className="adm-mono" style={{ fontSize: 11 }}>{r.userId?.slice(0, 12)}...</span> },
    { key: 'amountPaid', label: 'Оплата',      render: r => `${(r.amountPaid || 0).toLocaleString()} ₽` },
    { key: 'commission', label: 'Комиссия',    render: r => <b>{(r.commission || 0).toLocaleString()} ₽</b> },
    { key: 'status', label: 'Статус', render: r =>
        r.status === 'paid'
          ? <span className="adm-badge green">Выплачено</span>
          : <span className="adm-badge yellow">Ожидает</span>
    },
    { key: 'createdAt', label: 'Дата', render: r => r.createdAt ? r.createdAt.slice(0, 10) : '—' },
  ];

  return (
    <>
      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">Инфлюенсеры {data ? `(${data.referrers.length})` : ''}</span>
          <button className="adm-btn primary" onClick={() => setCreateModal(true)}>+ Добавить</button>
        </div>
        <DataTable<Referrer>
          columns={referrerCols}
          rows={data?.referrers || []}
          loading={loading}
          rowKey={r => r.id}
          emptyText={error || 'Нет инфлюенсеров'}
        />
      </div>

      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">История комиссий {data ? `(${data.earnings.length})` : ''}</span>
          <button className="adm-btn ghost" onClick={refetch}>Обновить</button>
        </div>
        <DataTable<Earning>
          columns={earningCols}
          rows={data?.earnings || []}
          loading={loading}
          rowKey={r => r.id}
          emptyText="Нет начислений"
        />
      </div>

      {payoutModal && (
        <Modal title={`Выплата — ${payoutModal.name}`} onClose={() => setPayoutModal(null)} footer={
          <>
            <button className="adm-btn ghost" onClick={() => setPayoutModal(null)}>Отмена</button>
            <button className="adm-btn primary" onClick={handlePayout} disabled={submitting || !payAmount}>
              {submitting ? 'Обработка...' : 'Выплатить'}
            </button>
          </>
        }>
          <div className="adm-form-row">
            <label className="adm-label">Сумма выплаты (макс. {(payoutModal.pendingPayout || 0).toLocaleString()} ₽)</label>
            <input className="adm-input" type="number" min={1} max={payoutModal.pendingPayout} value={payAmount} onChange={e => setPayAmount(e.target.value)} />
          </div>
          {payoutModal.paymentDetails && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              Реквизиты: <b style={{ color: 'var(--text)' }}>{payoutModal.paymentDetails}</b>
            </div>
          )}
        </Modal>
      )}

      {editModal && (
        <Modal title={`Редактировать — ${editModal.id}`} onClose={() => setEditModal(null)} footer={
          <>
            <button className="adm-btn ghost" onClick={() => setEditModal(null)}>Отмена</button>
            <button className="adm-btn primary" onClick={handleEdit} disabled={submitting}>Сохранить</button>
          </>
        }>
          <div className="adm-form-row">
            <label className="adm-label">Комиссия (%)</label>
            <input className="adm-input" type="number" value={editForm.commissionPercent} onChange={e => setEditForm(f => ({ ...f, commissionPercent: Number(e.target.value) }))} />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Скидка (%)</label>
            <input className="adm-input" type="number" value={editForm.discountPercent} onChange={e => setEditForm(f => ({ ...f, discountPercent: Number(e.target.value) }))} />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Статус</label>
            <select className="adm-select" value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
              <option value="active">Активен</option>
              <option value="inactive">Неактивен</option>
            </select>
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Реквизиты</label>
            <input className="adm-input" value={editForm.paymentDetails} onChange={e => setEditForm(f => ({ ...f, paymentDetails: e.target.value }))} placeholder="Карта, Tinkoff..." />
          </div>
        </Modal>
      )}

      {createModal && (
        <Modal title="Новый инфлюенсер" onClose={() => setCreateModal(false)} footer={
          <>
            <button className="adm-btn ghost" onClick={() => setCreateModal(false)}>Отмена</button>
            <button className="adm-btn primary" onClick={handleCreate} disabled={submitting || !createForm.code || !createForm.name}>Создать</button>
          </>
        }>
          <div className="adm-form-row">
            <label className="adm-label">Код (будет UPPERCASE)</label>
            <input className="adm-input" value={createForm.code} onChange={e => setCreateForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="IVAN2024" />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Имя</label>
            <input className="adm-input" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Иван" />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Комиссия (%)</label>
            <input className="adm-input" type="number" value={createForm.commissionPercent} onChange={e => setCreateForm(f => ({ ...f, commissionPercent: Number(e.target.value) }))} />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Скидка для покупателя (%)</label>
            <input className="adm-input" type="number" value={createForm.discountPercent} onChange={e => setCreateForm(f => ({ ...f, discountPercent: Number(e.target.value) }))} />
          </div>
        </Modal>
      )}
    </>
  );
}
