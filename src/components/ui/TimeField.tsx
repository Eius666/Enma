import React, { useId } from 'react';
import './TimeField.css';

interface TimeFieldProps {
  label: string;
  /** 'HH:MM', or '' when no time is set. */
  value: string;
  onChange: (value: string) => void;
  /** Shown instead of a time when none is set. */
  emptyText: string;
  /** Accessible name of the "remove the time" button. */
  clearLabel: string;
  /** Optional line under the field (for example, the time zone). */
  hint?: React.ReactNode;
}

// A time row that opens the system time picker when tapped anywhere on it.
//
// The native <input type="time"> is stretched, transparent, over the whole row:
// a tap on the row is a tap on the input itself, which is what opens the wheel
// picker in iOS WebKit (Telegram on iPhone) and the picker on Android. An empty
// time input has no width or placeholder of its own on iOS, so the value (or
// emptyText) is drawn by this component instead.
export function TimeField({ label, value, onChange, emptyText, clearLabel, hint }: TimeFieldProps): React.ReactElement {
  const id = useId();

  // A mouse has no tap-to-open; ask the browser for its picker where it can.
  const openPickerWithMouse = (e: React.MouseEvent<HTMLInputElement>) => {
    const input = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: fine)').matches) return;
    try { input.showPicker?.(); } catch { /* not allowed here — typing still works */ }
  };

  return (
    <div className="time-field">
      <div className="time-field__row">
        <label className="time-field__main" htmlFor={id}>
          <span className="time-field__label">{label}</span>
          <span className={`time-field__value${value ? '' : ' time-field__value--empty'}`} aria-hidden="true">
            {value || emptyText}
          </span>
          <input
            id={id}
            className="time-field__input"
            type="time"
            aria-label={label}
            value={value}
            onChange={e => onChange(e.target.value)}
            onClick={openPickerWithMouse}
          />
        </label>
        {value && (
          <button type="button" className="time-field__clear" onClick={() => onChange('')} aria-label={clearLabel}>
            ×
          </button>
        )}
      </div>
      {hint && <div className="time-field__hint">{hint}</div>}
    </div>
  );
}
