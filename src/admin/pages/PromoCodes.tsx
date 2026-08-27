import { useState } from 'react';
import { adminCall, useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

interface PromoCode {
  id: string;
  code: string;
  discountPercent: number;
  maxUses: number;
  usedCount: number;
  active: boolean;
}

interface PromoData { codes: PromoCode[] }

export default function PromoCodes() {
  const { data, loading, error, refetch } = useAdminApi<PromoData>('adminPromoCodes', {});
  const { toast } = useToast();
  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({ code: '', discountPercent: 20, maxUses: 100 });
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    if (!form.code) return;
    setSubmitting(true);
    try {
      await adminCall('adminPromoCodes', { action: 'create', ...form });
      toast(`Промокод ${form.code} создан`, 'success');
      setCreateModal(false);
      setForm({ code: '', discountPercent: 20, maxUses: 100 });
      refetch();
    } catch { toast('Ошибка создания', 'error'); }
    finally { setSubmitting(false); }
  }

  async function toggleCode(code: string, active: boolean) {
    try {
      await adminCall('adminPromoCodes', { action: 'toggle', code, active });
      toast(active ? 'Промокод активирован' : 'Промокод деактивирован', 'success');
      refetch();
    } catch { toast('Ошибка', 'error'); }
  }

  const columns: Column<PromoCode>[] = [
    { key: 'code', label: 'Код', render: r => <span className="adm-mono" style={{ color: '#c4b5fd', fontSize: 14 }}>{r.code}</span> },
    { key: 'discountPercent', label: 'Скидка', render: r => (
      <span className="adm-badge purple">{r.discountPercent}%</span>
    )},
    { key: 'usedCount', label: 'Использований', render: r => (
      <div>
        <b>{r.usedCount || 0}</b>
        <span style={{ color: 'var(--muted)' }}> / {r.maxUses}</span>
        <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, height: 4, marginTop: 4, width: 80 }}>
          <div style={{
            background: r.usedCount >= r.maxUses ? 'var(--red)' : 'var(--accent)',
            width: `${Math.min(100, ((r.usedCount || 0) / r.maxUses) * 100)}%`,
            height: '100%', borderRadius: 4,
          }} />
        </div>
      </div>
    )},
    { key: 'active', label: 'Статус', render: r =>
        r.active
          ? <span className="adm-badge green">Активен</span>
          : <span className="adm-badge red">Отключён</span>
    },
    { key: 'actions', label: '', sortable: false, render: r => (
      <button
        className={`adm-btn sm ${r.active ? 'danger' : 'success'}`}
        onClick={() => toggleCode(r.code, !r.active)}
      >
        {r.active ? 'Отключить' : 'Включить'}
      </button>
    )},
  ];

  return (
    <>
      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">Промокоды {data ? `(${data.codes.length})` : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="adm-btn ghost" onClick={refetch}>Обновить</button>
            <button className="adm-btn primary" onClick={() => setCreateModal(true)}>+ Создать</button>
          </div>
        </div>
        <DataTable<PromoCode>
          columns={columns}
          rows={data?.codes || []}
          loading={loading}
          rowKey={r => r.id}
          emptyText={error || 'Нет промокодов'}
        />
      </div>

      {createModal && (
        <Modal title="Новый промокод" onClose={() => setCreateModal(false)} footer={
          <>
            <button className="adm-btn ghost" onClick={() => setCreateModal(false)}>Отмена</button>
            <button className="adm-btn primary" onClick={handleCreate} disabled={submitting || !form.code}>
              {submitting ? 'Создаётся...' : 'Создать'}
            </button>
          </>
        }>
          <div className="adm-form-row">
            <label className="adm-label">Код (будет UPPERCASE)</label>
            <input
              className="adm-input"
              value={form.code}
              onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
              placeholder="SUMMER2025"
            />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Скидка (%)</label>
            <input
              className="adm-input"
              type="number"
              min={1}
              max={100}
              value={form.discountPercent}
              onChange={e => setForm(f => ({ ...f, discountPercent: Number(e.target.value) }))}
            />
          </div>
          <div className="adm-form-row">
            <label className="adm-label">Максимум активаций</label>
            <input
              className="adm-input"
              type="number"
              min={1}
              value={form.maxUses}
              onChange={e => setForm(f => ({ ...f, maxUses: Number(e.target.value) }))}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
