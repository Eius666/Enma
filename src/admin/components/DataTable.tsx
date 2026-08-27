import { useState } from 'react';
import { useMobile } from '../hooks/useMobile';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  pageSize?: number;
  rowKey: (row: T) => string | number;
  emptyText?: string;
}

export default function DataTable<T extends object>({
  columns, rows, loading, pageSize = 50, rowKey, emptyText = 'Нет данных',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage]       = useState(0);
  const isMobile              = useMobile();

  function handleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
    setPage(0);
  }

  let sorted = [...rows];
  if (sortKey) {
    sorted.sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey] ?? '';
      const bv = (b as Record<string, unknown>)[sortKey] ?? '';
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const totalPages  = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const paged       = sorted.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  if (loading) return <div className="adm-loading">Загрузка...</div>;
  if (!rows.length) return <div className="adm-empty">{emptyText}</div>;

  // Separate data columns from the actions column (empty label)
  const dataCols    = columns.filter(c => c.label !== '');
  const actionsCols = columns.filter(c => c.label === '');

  const pagination = totalPages > 1 && (
    <div className="adm-table-footer">
      <span>{rows.length} записей</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="adm-btn ghost sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={currentPage === 0}>← Назад</button>
        <span>{currentPage + 1} / {totalPages}</span>
        <button className="adm-btn ghost sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={currentPage === totalPages - 1}>Далее →</button>
      </div>
    </div>
  );

  /* ── Mobile card layout ── */
  if (isMobile) {
    return (
      <>
        <div className="adm-card-list">
          {paged.map(row => (
            <div key={rowKey(row)} className="adm-card-row">
              {dataCols.map(col => {
                const val = col.render
                  ? col.render(row)
                  : String((row as Record<string, unknown>)[col.key] ?? '');
                if (val === '' || val === null || val === undefined) return null;
                return (
                  <div key={col.key} className="adm-card-field">
                    <span className="adm-card-field-label">{col.label}</span>
                    <span className="adm-card-field-value">{val}</span>
                  </div>
                );
              })}
              {actionsCols.length > 0 && (
                <div className="adm-card-actions">
                  {actionsCols.map(col => (
                    <span key={col.key}>
                      {col.render ? col.render(row) : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {pagination}
      </>
    );
  }

  /* ── Desktop table layout ── */
  return (
    <>
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key} onClick={() => col.sortable !== false && handleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map(row => (
              <tr key={rowKey(row)}>
                {columns.map(col => (
                  <td key={col.key}>
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination}
    </>
  );
}
