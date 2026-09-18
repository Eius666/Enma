import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import './Insights.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InsightAction {
  type:   'skill' | 'tool';
  target: string;
  params?: Record<string, unknown>;
}

export interface Insight {
  id:          string;
  fingerprint: string;
  type:        string;
  domain:      string;
  severity:    'info' | 'warning' | 'critical';
  title:       string;
  bodyText?:   string;
  action?:     InsightAction | null;
  status:      string;
  detectedAt?: { toMillis?: () => number } | null;
  score?:      number;
}

interface InsightsFeedProps {
  user:        User | null;
  language:    'en' | 'ru';
  /** Maximum cards to show on the home screen (default: 3) */
  maxVisible?: number;
  /** Called when user clicks a CTA — tells the parent to navigate somewhere */
  onCta?:      (action: InsightAction) => void;
}

// ── Label map for CTA buttons ─────────────────────────────────────────────────

const CTA_LABELS: Record<string, { ru: string; en: string }> = {
  'finance.cashflow':    { ru: 'Посмотреть поток', en: 'View cashflow'  },
  'finance.leaks':       { ru: 'Найти утечки',      en: 'Find leaks'    },
  'finance.goal':        { ru: 'К цели',             en: 'View goal'     },
  'finance.month_review':{ ru: 'Разбор месяца',      en: 'Month review'  },
  'tasks.prioritize':    { ru: 'К задаче',            en: 'View task'     },
};

function ctaLabel(target: string, lang: 'en' | 'ru'): string {
  return CTA_LABELS[target]?.[lang] ?? (lang === 'ru' ? 'Открыть' : 'Open');
}

// ── Severity decorators ───────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  critical: '🚨',
  warning:  '⚠️',
  info:     'ℹ️',
};

function timeAgo(insight: Insight, lang: 'en' | 'ru'): string {
  const ts = insight.detectedAt?.toMillis?.() ?? 0;
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 60000);
  if (diff < 2)   return lang === 'ru' ? 'только что' : 'just now';
  if (diff < 60)  return lang === 'ru' ? `${diff} мин.` : `${diff}m`;
  const hours = Math.floor(diff / 60);
  if (hours < 24) return lang === 'ru' ? `${hours} ч.` : `${hours}h`;
  return lang === 'ru' ? `${Math.floor(hours / 24)} дн.` : `${Math.floor(hours / 24)}d`;
}

// ── InsightCard ───────────────────────────────────────────────────────────────

interface CardProps {
  insight:  Insight;
  language: 'en' | 'ru';
  onDismiss: (fingerprint: string) => void;
  onCta?:    (action: InsightAction) => void;
}

const InsightCard: React.FC<CardProps> = ({ insight, language, onDismiss, onCta }) => {
  const icon   = ICONS[insight.severity] ?? '📊';
  const canCta = !!insight.action?.target && !!onCta;

  return (
    <div className={`insight-card insight-card--${insight.severity}`} role="article">
      <div className="insight-card__header">
        <span className="insight-card__icon" aria-hidden="true">{icon}</span>
        <span className="insight-card__title">{insight.title}</span>
        <button
          className="insight-card__dismiss"
          aria-label={language === 'ru' ? 'Скрыть' : 'Dismiss'}
          type="button"
          onClick={() => onDismiss(insight.fingerprint)}
        >✕</button>
      </div>

      {insight.bodyText && (
        <p className="insight-card__body">{insight.bodyText}</p>
      )}

      <div className="insight-card__footer">
        {canCta && insight.action && (
          <button
            className="insight-card__cta"
            type="button"
            onClick={() => onCta!(insight.action!)}
          >
            {ctaLabel(insight.action.target, language)}
          </button>
        )}
        <span className="insight-card__time">{timeAgo(insight, language)}</span>
      </div>
    </div>
  );
};

// ── InsightsFeed ──────────────────────────────────────────────────────────────

const InsightsFeed: React.FC<InsightsFeedProps> = ({
  user,
  language,
  maxVisible = 3,
  onCta,
}) => {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading,  setLoading]  = useState(false);

  const fetchInsights = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const resp  = await fetch('/api/insights/list', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.ok && Array.isArray(data.insights)) {
        setInsights(data.insights.slice(0, maxVisible));
      }
    } catch {
      // Non-fatal — insights feed is decorative, never blocks main UI
    } finally {
      setLoading(false);
    }
  }, [user, maxVisible]);

  useEffect(() => {
    fetchInsights();
    // Refresh every 5 minutes while the tab is visible
    const id = setInterval(fetchInsights, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchInsights]);

  const handleDismiss = useCallback(async (fingerprint: string) => {
    if (!user) return;
    // Optimistic removal
    setInsights(prev => prev.filter(i => i.fingerprint !== fingerprint));
    try {
      const token = await user.getIdToken();
      await fetch('/api/insights/dismiss', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fingerprint }),
      });
    } catch {
      // Already removed from UI; server will self-heal on next fetch
    }
  }, [user]);

  if (loading && insights.length === 0) return null;
  if (insights.length === 0) return null;

  return (
    <div className="insights-feed" aria-label={language === 'ru' ? 'Подсказки ENMA' : 'ENMA insights'}>
      {insights.map(insight => (
        <InsightCard
          key={insight.fingerprint}
          insight={insight}
          language={language}
          onDismiss={handleDismiss}
          onCta={onCta}
        />
      ))}
    </div>
  );
};

export default InsightsFeed;
