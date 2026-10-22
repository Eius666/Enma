import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ModalSheet.css';

interface ModalSheetProps {
  title: string;
  /** Accessible name of the close button. */
  closeLabel: string;
  onClose: () => void;
  /** Shown before the title (decorative). */
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A bottom sheet over a dimmed backdrop, above everything (the bottom
// navigation included), rendered into <body>.
//
// - One tap on the backdrop closes it. The backdrop is a real button that
//   receives the whole click, so nothing underneath is activated, and closing
//   happens on that click — no delay and no second tap.
// - A close button, Escape, and Tab kept inside the sheet.
// - The page behind does not scroll while it is open; its scroll position and
//   the previously focused element are restored on close.
// - Long content scrolls inside the sheet; safe areas are respected (CSS).
export function ModalSheet({ title, closeLabel, onClose, icon, children }: ModalSheetProps): React.ReactElement {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollY = window.scrollY;
    const { body, documentElement: html } = document;
    const saved = { body: body.style.overflow, html: html.style.overflow };
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      body.style.overflow = saved.body;
      html.style.overflow = saved.html;
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className="modal-sheet">
      {/* A touch target only: keyboard and screen readers use the close button or Escape. */}
      <button type="button" className="modal-sheet__backdrop" data-testid="modal-backdrop" aria-hidden="true" tabIndex={-1} onClick={onClose} />
      <div
        ref={dialogRef}
        className="modal-sheet__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-sheet__header">
          {icon && <span className="modal-sheet__icon" aria-hidden="true">{icon}</span>}
          <h2 id={titleId} className="modal-sheet__title">{title}</h2>
          <button type="button" className="modal-sheet__close" aria-label={closeLabel} onClick={onClose}>×</button>
        </div>
        <div className="modal-sheet__body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
