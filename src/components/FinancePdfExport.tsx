import React, { useId } from 'react';
import type { User } from 'firebase/auth';
import { FaFilePdf } from 'react-icons/fa';
import type { Subscription } from '../subscription';
import { pdfExportAccess, PDF_MONTHLY_LIMIT } from '../lib/financePdfExport';
import { useFinancePdfExport } from '../hooks/useFinancePdfExport';
import type { PdfExportPhase } from '../hooks/useFinancePdfExport';
import './FinancePdfExport.css';

// The two entry points to the finance PDF report — a compact button in the
// Finance tab (Premium only) and a block in Settings (every plan) — on top of
// the same export (src/lib/financePdfExport.ts, useFinancePdfExport).

const T = {
  en: {
    financeButton: 'Finance report',
    sectionLabel: 'Reports',
    title: 'Finance PDF reports',
    description: 'Income, expenses, categories, accounts and goals in one PDF file you can keep or share.',
    premiumOnly: 'Available with Premium',
    upgrade: 'Upgrade to Premium',
    download: 'Download PDF report',
    generating: 'Generating report…',
    checking: 'Checking your plan…',
    done: 'Report downloaded',
    remaining: (left: number, limit: number) => `Left this month: ${left} of ${limit}`,
    limitReached: 'This month’s PDF report limit has been reached.',
    notPremium: 'PDF reports are available on Premium.',
    failed: 'Could not generate the report. Please try again.',
  },
  ru: {
    financeButton: 'Финансовый отчёт',
    sectionLabel: 'Отчёты',
    title: 'Финансовые PDF-отчёты',
    description: 'Доходы, расходы, категории, счета и цели — в одном PDF-файле, который можно сохранить или отправить.',
    premiumOnly: 'Доступно с Premium',
    upgrade: 'Перейти на Premium',
    download: 'Скачать PDF-отчёт',
    generating: 'Формируем отчёт…',
    checking: 'Проверяем тариф…',
    done: 'Отчёт скачан',
    remaining: (left: number, limit: number) => `Осталось в этом месяце: ${left} из ${limit}`,
    limitReached: 'Лимит PDF-отчётов на этот месяц исчерпан.',
    notPremium: 'PDF-отчёты доступны на тарифе Premium.',
    failed: 'Не удалось сформировать отчёт. Попробуйте ещё раз.',
  },
};

type Strings = typeof T.en;

function errorText(state: PdfExportPhase, t: Strings): string | null {
  if (state.phase !== 'error') return null;
  if (state.reason === 'limit') return t.limitReached;
  if (state.reason === 'not_premium') return t.notPremium;
  return state.message ?? t.failed;
}

interface Props {
  language: 'en' | 'ru';
  user: User | null;
  subscription: Subscription | null;
  subscriptionLoaded: boolean;
}

/** Finance tab: shown only when the server grants the export (Premium, paid or trial). */
export function FinancePdfButton({ language, user, subscription, subscriptionLoaded }: Props): React.ReactElement | null {
  const t = T[language];
  const access = pdfExportAccess(subscription, subscriptionLoaded);
  const { state, exhausted, run } = useFinancePdfExport(user, access);
  if (access !== 'available') return null;
  const loading = state.phase === 'loading';
  const error = errorText(state, t);
  return (
    <div className="fin-pdf">
      <button type="button" className="fin-pdf__btn" onClick={run} disabled={loading || exhausted} aria-busy={loading}>
        <FaFilePdf className="fin-pdf__icon" aria-hidden="true" />
        <span>{loading ? t.generating : t.financeButton}</span>
      </button>
      {exhausted && state.phase !== 'error' && <p className="fin-pdf__note">{t.limitReached}</p>}
      {error && <p className="fin-pdf__error" role="alert">{error}</p>}
    </div>
  );
}

/** Settings: the block every plan sees; the upgrade button opens the existing subscription panel. */
export function FinancePdfSettingsBlock({
  language, user, subscription, subscriptionLoaded, onUpgrade,
}: Props & { onUpgrade: () => void }): React.ReactElement {
  const t = T[language];
  const titleId = useId();
  const access = pdfExportAccess(subscription, subscriptionLoaded);
  const { state, remaining, exhausted, run } = useFinancePdfExport(user, access);
  const loading = state.phase === 'loading';
  const error = errorText(state, t);
  return (
    <>
      <div className="sett-group__label">{t.sectionLabel}</div>
      <section className="sett-group sett-pdf" aria-labelledby={titleId}>
        <div className="sett-pdf__head">
          <span className="sett-row__icon-wrap" aria-hidden="true">
            <FaFilePdf className="sett-row__icon sett-row__icon--accent" />
          </span>
          <h3 className="sett-pdf__title" id={titleId}>{t.title}</h3>
          {access === 'locked' && <span className="sett-pdf__badge">{t.premiumOnly}</span>}
        </div>
        <p className="sett-pdf__desc">{t.description}</p>
        <div className="sett-pdf__actions">
          {access === 'loading' && <p className="sett-pdf__note">{t.checking}</p>}
          {access === 'locked' && (
            <button type="button" className="sett-export-pdf-btn" onClick={onUpgrade}>{t.upgrade}</button>
          )}
          {access === 'available' && (
            <>
              <button type="button" className="sett-export-pdf-btn" onClick={run} disabled={loading || exhausted} aria-busy={loading}>
                {loading ? t.generating : t.download}
              </button>
              {exhausted && state.phase !== 'error' && <p className="sett-pdf__note">{t.limitReached}</p>}
              {!exhausted && remaining !== null && <p className="sett-pdf__note">{t.remaining(remaining, PDF_MONTHLY_LIMIT)}</p>}
              {state.phase === 'done' && <p className="sett-pdf__note" role="status">{t.done}</p>}
              {error && <p className="sett-export-pdf-error" role="alert">{error}</p>}
            </>
          )}
        </div>
      </section>
    </>
  );
}
