import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { exportFinancePdf, PDF_MONTHLY_LIMIT } from '../lib/financePdfExport';
import type { PdfAccess } from '../lib/financePdfExport';
import { subscribeAiUsage } from '../lib/usageCounters';

export type PdfExportPhase =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done' }
  | { phase: 'error'; reason: 'limit' | 'not_premium' | 'failed'; message: string | null };

// State of the finance PDF export for one screen: the request (one at a time,
// only on a tap — rendering never asks the server for anything) and this
// month's remaining reports, read live from aiUsage/{uid} while the export is
// available. `remaining` is null while unknown; a failed read stays unknown
// rather than looking like an untouched quota.
export function useFinancePdfExport(user: User | null, access: PdfAccess) {
  const [state, setState] = useState<PdfExportPhase>({ phase: 'idle' });
  const [used, setUsed] = useState<number | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    setUsed(null);
    if (!user || access !== 'available') return;
    return subscribeAiUsage(user.uid, u => setUsed(u.pdfReports), () => setUsed(null));
  }, [user, access]);

  const remaining = used === null ? null : Math.max(0, PDF_MONTHLY_LIMIT - used);
  const exhausted = limitHit || remaining === 0;

  const run = useCallback(async () => {
    if (!user || access !== 'available' || exhausted || busy.current) return;
    busy.current = true;
    setState({ phase: 'loading' });
    const result = await exportFinancePdf(user);
    busy.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      setState({ phase: 'done' });
    } else {
      if (result.reason === 'limit') setLimitHit(true);
      setState({ phase: 'error', reason: result.reason, message: result.message });
    }
  }, [user, access, exhausted]);

  return { state, remaining, exhausted, run };
}
