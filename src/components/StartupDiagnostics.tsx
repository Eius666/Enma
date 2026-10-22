import React, { useMemo, useState } from 'react';
import { FaStopwatch } from 'react-icons/fa';
import {
  startupDiagnosticsAvailable, isStartupDiagnosticsOn, setStartupDiagnostics, readLastStartupRun,
} from '../lib/perfMarks';
import { formatStartupRun } from '../lib/startupRunText';

// Settings → "Startup diagnostics" (not on production builds): a switch that
// records how long each step of the next starts takes, and the timings of the
// last start as text to read or copy. Only step names and milliseconds are
// stored, on this device; nothing is sent.
export function StartupDiagnostics({ language }: { language: 'en' | 'ru' }): React.ReactElement | null {
  const [on, setOn] = useState(isStartupDiagnosticsOn);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const run = useMemo(() => (on ? readLastStartupRun() : null), [on]);
  if (!startupDiagnosticsAvailable) return null;

  const ru = language === 'ru';
  const text = run ? formatStartupRun(run, language) : '';

  const toggle = () => {
    setStartupDiagnostics(!on);
    setOn(!on);
    setCopied('idle');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <>
      <div className="sett-group__label">{ru ? 'Диагностика (DEV)' : 'Diagnostics (DEV)'}</div>
      <div className="sett-group">
        <button className="sett-row" onClick={toggle} type="button" role="switch" aria-checked={on}>
          <div className="sett-row__icon-wrap">
            <FaStopwatch className="sett-row__icon" />
          </div>
          <span className="sett-row__label">{ru ? 'Диагностика запуска' : 'Startup diagnostics'}</span>
          <span className={`sett-toggle${on ? ' sett-toggle--on' : ''}`} aria-hidden="true" />
        </button>
        <p className="sett-diag__hint">
          {on
            ? (ru
              ? 'Закройте мини-приложение и откройте снова — здесь появится время этапов этого запуска. Хранятся только названия этапов и миллисекунды, на этом устройстве.'
              : 'Close the mini app and open it again — the timings of that start appear here. Only step names and milliseconds are kept, on this device.')
            : (ru
              ? 'Записывать, сколько длится каждый этап запуска (для разработчиков).'
              : 'Record how long each step of the start takes (for developers).')}
        </p>
        {on && run && (
          <>
            <pre className="sett-diag__run">{text}</pre>
            <button className="sett-row" onClick={copy} type="button">
              <span className="sett-row__label">
                {copied === 'ok' ? (ru ? 'Скопировано' : 'Copied')
                  : copied === 'failed' ? (ru ? 'Не удалось скопировать — сделайте скриншот' : 'Could not copy — take a screenshot')
                  : (ru ? 'Скопировать' : 'Copy')}
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}
