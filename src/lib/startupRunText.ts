// The text of a recorded start for Settings → Startup diagnostics (and for
// copying). Kept out of perfMarks.ts so it is only in the Settings chunk.

import type { PerfPhase, StartupRun } from './perfMarks';

const at = (run: StartupRun, phase: PerfPhase): number | undefined => run.marks.find(m => m.phase === phase)?.ms;

/** The run as plain text for the Settings screen (and for copying). */
export function formatStartupRun(run: StartupRun, language: 'en' | 'ru'): string {
  const ru = language === 'ru';
  const ms = (v: number | undefined) => (v === undefined ? '—' : `${v} ${ru ? 'мс' : 'ms'}`);
  const lines: string[] = [];
  lines.push(`${ru ? 'Запуск' : 'Start'}: ${run.recordedAt.replace('T', ' ').slice(0, 19)} UTC (${run.navigationType ?? '?'})`);
  lines.push(`${ru ? 'Первый экран' : 'First screen'}: ${ms(at(run, 'first-render'))}`);
  lines.push(`${ru ? 'Интерфейс готов' : 'Interface ready'}: ${ms(at(run, 'shell-rendered'))}`);
  lines.push(`${ru ? 'Задачи' : 'Tasks'}: ${ms(at(run, 'first-snapshot:tasks'))} · ${ru ? 'финансы' : 'finance'}: ${ms(at(run, 'first-snapshot:transactions'))}`);
  lines.push('');
  lines.push(`HTML: ${ms(run.page.htmlReceived)} · main.js: ${ms(run.page.bundleStarted)} · DOM: ${ms(run.page.domReady)}`);
  for (const r of run.requests) {
    const extra = [r.count > 1 ? `×${r.count}` : '', r.cached === true ? (ru ? 'кэш' : 'cache') : ''].filter(Boolean).join(' ');
    lines.push(`  ${r.name}: ${r.start}→${r.end}${extra ? ` (${extra})` : ''}`);
  }
  lines.push('');
  for (const m of run.marks) lines.push(`  ${m.phase}: ${m.ms}`);
  return lines.join('\n');
}
