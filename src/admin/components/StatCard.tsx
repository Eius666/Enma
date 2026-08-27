interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  color?: 'green' | 'purple' | 'yellow' | 'default';
}

export default function StatCard({ label, value, sub, color = 'default' }: StatCardProps) {
  return (
    <div className="adm-stat-card">
      <div className="adm-stat-label">{label}</div>
      <div className={`adm-stat-value ${color !== 'default' ? color : ''}`}>{value}</div>
      {sub && <div className="adm-stat-sub">{sub}</div>}
    </div>
  );
}
