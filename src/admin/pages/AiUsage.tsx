import { useState } from 'react';
import { useAdminApi } from '../hooks/useAdminApi';
import DataTable, { Column } from '../components/DataTable';
import StatCard from '../components/StatCard';

interface UsageRow {
  userId: string;
  textRequests: number;
  imageRequests: number;
  pdfReports: number;
  updatedAt: string;
}

interface AiData {
  month: string;
  usage: UsageRow[];
  totals: { textRequests: number; imageRequests: number; pdfReports: number };
}

export default function AiUsage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  const aiState = useAdminApi<AiData>('adminAiUsage', { month });

  const columns: Column<UsageRow>[] = [
    { key: 'userId',       label: 'User ID',  render: r => <span className="adm-mono" style={{ fontSize: 11 }}>{r.userId}</span> },
    { key: 'textRequests', label: 'Текст',    render: r => r.textRequests  > 0 ? <b style={{ color: 'var(--accent2)' }}>{r.textRequests}</b> : '—' },
    { key: 'imageRequests',label: 'Изображения', render: r => r.imageRequests > 0 ? <b style={{ color: 'var(--yellow)' }}>{r.imageRequests}</b> : '—' },
    { key: 'pdfReports',   label: 'PDF отчёты', render: r => r.pdfReports > 0 ? <b style={{ color: 'var(--green)' }}>{r.pdfReports}</b> : '—' },
    { key: 'total', label: 'Всего', sortable: false, render: r =>
        <b>{(r.textRequests || 0) + (r.imageRequests || 0) + (r.pdfReports || 0)}</b>
    },
    { key: 'updatedAt', label: 'Обновлено', render: r => r.updatedAt ? r.updatedAt.slice(0, 10) : '—' },
  ];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div>
          <label className="adm-label">Месяц</label>
          <input
            className="adm-input"
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            style={{ width: 160 }}
          />
        </div>
      </div>

      {aiState.data && (
        <div className="adm-kpi-grid" style={{ marginBottom: 24 }}>
          <StatCard label="Текстовых запросов" value={aiState.data.totals.textRequests.toLocaleString()} color="purple" />
          <StatCard label="Генерации изображений" value={aiState.data.totals.imageRequests.toLocaleString()} color="yellow" />
          <StatCard label="PDF отчётов" value={aiState.data.totals.pdfReports.toLocaleString()} color="green" />
          <StatCard
            label="Всего запросов"
            value={(aiState.data.totals.textRequests + aiState.data.totals.imageRequests + aiState.data.totals.pdfReports).toLocaleString()}
          />
        </div>
      )}

      <div className="adm-table-card">
        <div className="adm-table-header">
          <span className="adm-table-title">AI-расходы за {month} — {aiState.data ? `${aiState.data.usage.length} пользователей` : ''}</span>
        </div>
        <DataTable<UsageRow>
          columns={columns}
          rows={(aiState.data?.usage || []).sort((a, b) =>
            ((b.textRequests || 0) + (b.imageRequests || 0) + (b.pdfReports || 0)) -
            ((a.textRequests || 0) + (a.imageRequests || 0) + (a.pdfReports || 0))
          )}
          loading={aiState.loading}
          rowKey={r => r.userId}
          emptyText={aiState.error || 'Нет данных за выбранный месяц'}
        />
      </div>
    </>
  );
}
