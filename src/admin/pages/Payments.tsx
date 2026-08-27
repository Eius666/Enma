import { useState } from 'react';
import { useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';

interface Payment {
  id: string;
  userId: string;
  amount: number;
  method: string;
  status: string;
  createdAt: string;
  promoCode: string;
  referralCode: string;
  plan: string;
  period: string;
  transactionId: string;
}

interface PaymentsData { payments: Payment[]; totalRevenue: number }

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: 'green', confirmed: 'green',
  CANCELED: 'red',   canceled: 'red',
  pending: 'yellow', PENDING: 'yellow',
};

export default function Payments() {
  const [statusFilter, setStatusFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('');

  const { data, loading, error, refetch } = useAdminApi<PaymentsData>('adminPayments', {
    limit: 200, statusFilter: statusFilter || undefined, methodFilter: methodFilter || undefined,
  });

  const columns: Column<Payment>[] = [
    { key: 'id',       label: 'ID',     render: r => <span className="adm-mono" style={{ fontSize: 11 }}>{r.id.slice(0, 8)}...</span> },
    { key: 'userId',   label: 'User',   render: r => <span className="adm-mono" style={{ fontSize: 11 }}>{r.userId?.slice(0, 10)}...</span> },
    { key: 'amount',   label: 'Сумма',  render: r => <b>{(r.amount || 0).toLocaleString()} ₽</b> },
    { key: 'method',   label: 'Метод',  render: r => <span className="adm-badge gray">{r.method}</span> },
    { key: 'status',   label: 'Статус', render: r => {
      const color = STATUS_COLORS[r.status] || 'gray';
      return <span className={`adm-badge ${color}`}>{r.status}</span>;
    }},
    { key: 'plan',     label: 'Тариф',  render: r => r.plan ? `${r.plan}/${r.period || '?'}` : '—' },
    { key: 'promoCode',label: 'Промо/Реф', render: r => {
      const code = r.promoCode || r.referralCode;
      return code ? <span className="adm-mono">{code}</span> : <span style={{ color: 'var(--muted)' }}>—</span>;
    }},
    { key: 'createdAt',label: 'Дата',   render: r => r.createdAt ? r.createdAt.slice(0, 16).replace('T', ' ') : '—' },
  ];

  return (
    <div className="adm-table-card">
      <div className="adm-table-header">
        <span className="adm-table-title">
          Платежи {data ? `(${data.payments.length})` : ''}
          {data && data.totalRevenue > 0 && (
            <span style={{ marginLeft: 12, color: 'var(--green)', fontWeight: 700 }}>
              {data.totalRevenue.toLocaleString()} ₽
            </span>
          )}
        </span>
        <div className="adm-filters">
          <select className="adm-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">Все статусы</option>
            <option value="CONFIRMED">CONFIRMED</option>
            <option value="confirmed">confirmed</option>
            <option value="CANCELED">CANCELED</option>
            <option value="pending">pending</option>
          </select>
          <select className="adm-select" value={methodFilter} onChange={e => setMethodFilter(e.target.value)}>
            <option value="">Все методы</option>
            <option value="sbp">SBP</option>
            <option value="ton">TON</option>
            <option value="usdt">USDT</option>
            <option value="stars">Stars</option>
          </select>
          <button className="adm-btn ghost" onClick={refetch}>Обновить</button>
        </div>
      </div>
      <DataTable<Payment>
        columns={columns}
        rows={data?.payments || []}
        loading={loading}
        rowKey={r => r.id}
        emptyText={error || 'Нет платежей'}
        pageSize={50}
      />
    </div>
  );
}
