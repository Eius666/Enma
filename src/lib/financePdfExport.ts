import type { User } from 'firebase/auth';
import { AI_LIMITS, getPlanDisplay } from '../subscription';
import type { Subscription } from '../subscription';

// The one finance PDF export used by both entry points (the Finance tab button
// and the Settings block). The server decides: POST /api/ai/exportFinancePdf
// checks the plan and the monthly quota with the caller's Firebase ID token
// (api/_lib/finance/financeHandlers.js) and answers with the PDF itself.

/** Reports per month on Premium (the server's limit, parity-tested). */
export const PDF_MONTHLY_LIMIT = AI_LIMITS.premium.pdfReports;

export type PdfAccess = 'loading' | 'locked' | 'available';

// Whether the server would export for this subscription document: the plan it
// grants (api/_lib/subscription/plan.js, mirrored by getPlanDisplay) is
// Premium — paid, or a running Premium trial. Unknown until the document has
// been read; a state the server would refuse is never shown as available.
export function pdfExportAccess(subscription: Subscription | null, subscriptionLoaded: boolean): PdfAccess {
  if (!subscriptionLoaded) return 'loading';
  const shown = getPlanDisplay(subscription);
  return shown.kind !== 'none' && shown.plan === 'premium' ? 'available' : 'locked';
}

export type PdfExportResult =
  | { ok: true; filename: string }
  | { ok: false; reason: 'limit' | 'not_premium' | 'failed'; message: string | null };

let inFlight: Promise<PdfExportResult> | null = null;

/**
 * Asks the server for the report and hands the file to the browser. A call
 * made while one is still running gets that same request's result instead of
 * starting (and paying for) a second one.
 */
export function exportFinancePdf(user: User): Promise<PdfExportResult> {
  if (!inFlight) {
    inFlight = requestAndDownload(user).finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function requestAndDownload(user: User): Promise<PdfExportResult> {
  try {
    const token = await user.getIdToken();
    const resp = await fetch('/api/ai/exportFinancePdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ period: 'all' }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 429 && body.code === 'pdf_limit') {
        return { ok: false, reason: body.plan === 'premium' ? 'limit' : 'not_premium', message: null };
      }
      return { ok: false, reason: 'failed', message: typeof body.error === 'string' ? body.error : null };
    }
    // Delivered as this request's own response body — never a stored file or
    // a link; the blob lives in this tab only until the download starts.
    const blob = await resp.blob();
    const disposition = resp.headers.get('Content-Disposition') || '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'ENMA-finance-report.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, filename };
  } catch {
    return { ok: false, reason: 'failed', message: null };
  }
}
