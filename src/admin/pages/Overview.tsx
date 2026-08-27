import { useAdminApi } from '../hooks/useAdminApi';
import StatCard from '../components/StatCard';

interface RecentPayment {
  id: string; userId: string; amount: number; plan: string; method: string; promoCode: string; createdAt: string;
}
interface RecentUser {
  uid: string; displayName: string; username: string; createdAt: string;
}
interface StatsData {
  totalUsers: number;
  payingUsers: number;
  newToday: number;
  newWeek: number;
  newMonth: number;
  revenueMonth: number;
  pendingPayouts: number;
  aiRequestsMonth: number;
  topReferrers: { id: string; name: string; totalEarned: number; pendingPayout: number }[];
  regsByDay: Record<string, number>;
  revByDay: Record<string, number>;
  planDist: { free: number; pro: number; premium: number };
  recentPayments: RecentPayment[];
  recentUsers: RecentUser[];
}

function BarChart({ data, color = '#7c3aed', label }: { data: Record<string, number>; color?: string; label: string }) {
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const W = entries.length;

  return (
    <div className="adm-chart-card">
      <div className="adm-chart-title">{label}</div>
      <div className="adm-bar-chart">
        <svg viewBox={`0 0 ${W * 12} 80`} preserveAspectRatio="none" style={{ height: 80 }}>
          {entries.map(([, value], i) => {
            const barH = Math.max(2, Math.round((value / max) * 72));
            return (
              <rect
                key={i}
                x={i * 12 + 1}
                y={78 - barH}
                width={10}
                height={barH}
                fill={color}
                opacity={0.8}
                rx={2}
              />
            );
          })}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
          {entries.length > 0 && <span>{entries[0][0].slice(5)}</span>}
          {entries.length > 0 && <span>{entries[entries.length - 1][0].slice(5)}</span>}
        </div>
      </div>
    </div>
  );
}

function PieChart({ planDist }: { planDist: { free: number; pro: number; premium: number } }) {
  const total = planDist.free + planDist.pro + planDist.premium || 1;
  const slices = [
    { label: 'Free',    value: planDist.free,    color: '#4b5563', pct: planDist.free    / total },
    { label: 'Pro',     value: planDist.pro,     color: '#7c3aed', pct: planDist.pro     / total },
    { label: 'Premium', value: planDist.premium, color: '#f59e0b', pct: planDist.premium / total },
  ];

  let cumulativePct = 0;
  const paths = slices.map(s => {
    const startAngle = cumulativePct * Math.PI * 2 - Math.PI / 2;
    cumulativePct += s.pct;
    const endAngle = cumulativePct * Math.PI * 2 - Math.PI / 2;
    const large = s.pct > 0.5 ? 1 : 0;
    const x1 = Math.cos(startAngle), y1 = Math.sin(startAngle);
    const x2 = Math.cos(endAngle),   y2 = Math.sin(endAngle);
    const d = s.pct >= 0.9999
      ? 'M 0 -1 A 1 1 0 1 1 0.0001 -1 Z'
      : `M 0 0 L ${x1} ${y1} A 1 1 0 ${large} 1 ${x2} ${y2} Z`;
    return { ...s, d };
  });

  return (
    <div className="adm-chart-card">
      <div className="adm-chart-title">Тарифы</div>
      <div className="adm-pie-wrap">
        <svg width={100} height={100} viewBox="-1.1 -1.1 2.2 2.2">
          {paths.map((s, i) => <path key={i} d={s.d} fill={s.color} />)}
          <circle r={0.55} fill="var(--card)" />
        </svg>
        <div className="adm-pie-legend">
          {slices.map(s => (
            <div key={s.label} className="adm-pie-legend-item">
              <div className="adm-pie-dot" style={{ background: s.color }} />
              <span>{s.label}: {s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Overview() {
  const { data: stats, loading, error } = useAdminApi<StatsData>('adminStats', {});

  if (loading) return <div className="adm-loading">Загрузка статистики...</div>;
  if (error)   return <div className="adm-empty">Ошибка: {error}</div>;
  if (!stats)  return null;

  return (
    <>
      <div className="adm-kpi-grid">
        <StatCard label="Всего пользователей" value={stats.totalUsers.toLocaleString()} color="default" />
        <StatCard label="Платящих" value={stats.payingUsers.toLocaleString()} color="purple" />
        <StatCard label="Новых сегодня" value={stats.newToday} sub={`${stats.newWeek} за неделю, ${stats.newMonth} за месяц`} color="green" />
        <StatCard label="Выручка за месяц" value={`${stats.revenueMonth.toLocaleString()} ₽`} color="green" />
        <StatCard label="AI-запросов за месяц" value={stats.aiRequestsMonth.toLocaleString()} color="default" />
        <StatCard label="Выплаты рефералам" value={`${stats.pendingPayouts.toLocaleString()} ₽`} color="yellow" sub="ожидают выплаты" />
      </div>

      <div className="adm-charts-row">
        <BarChart data={stats.regsByDay} color="#7c3aed" label="Регистрации по дням (30д)" />
        <BarChart data={stats.revByDay}  color="#22c55e" label="Выручка по дням (30д)" />
        <PieChart planDist={stats.planDist} />
      </div>

      {stats.topReferrers.length > 0 && (
        <div className="adm-table-card">
          <div className="adm-table-header">
            <span className="adm-table-title">Топ инфлюенсеры</span>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table adm-ref-table">
              <thead>
                <tr><th>Код</th><th>Имя</th><th>Всего заработано</th><th>К выплате</th></tr>
              </thead>
              <tbody>
                {stats.topReferrers.map(r => (
                  <tr key={r.id}>
                    <td className="adm-mono">{r.id}</td>
                    <td>{r.name}</td>
                    <td>{(r.totalEarned || 0).toLocaleString()} ₽</td>
                    <td>
                      {(r.pendingPayout || 0) > 0
                        ? <span className="adm-badge yellow">{(r.pendingPayout || 0).toLocaleString()} ₽</span>
                        : <span className="adm-badge gray">0 ₽</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="adm-table-card">
          <div className="adm-table-header">
            <span className="adm-table-title">Последние платежи</span>
          </div>
          {!stats.recentPayments?.length ? (
            <div className="adm-empty">Нет платежей</div>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr><th>Сумма</th><th>Метод</th><th>Тариф</th><th>Промо</th><th>Дата</th></tr>
                </thead>
                <tbody>
                  {stats.recentPayments.map(p => (
                    <tr key={p.id}>
                      <td><b style={{ color: 'var(--green)' }}>{(p.amount || 0).toLocaleString()} ₽</b></td>
                      <td><span className="adm-badge gray">{p.method || '—'}</span></td>
                      <td>{p.plan || '—'}</td>
                      <td>{p.promoCode ? <span className="adm-mono" style={{ fontSize: 11 }}>{p.promoCode}</span> : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{p.createdAt ? p.createdAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="adm-table-card">
          <div className="adm-table-header">
            <span className="adm-table-title">Новые пользователи</span>
          </div>
          {!stats.recentUsers?.length ? (
            <div className="adm-empty">Нет пользователей</div>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr><th>Имя</th><th>Username</th><th>Дата</th></tr>
                </thead>
                <tbody>
                  {stats.recentUsers.map(u => (
                    <tr key={u.uid}>
                      <td>{u.displayName || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                      <td>{u.username ? <span className="adm-mono">@{u.username}</span> : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{u.createdAt ? u.createdAt.slice(0, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
