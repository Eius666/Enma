import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModalSheet } from '../ui/ModalSheet';

// BUG-07: the modal sheet the AI preview is shown in.

function Page({ open, onClose, onUnderneath, onInside }: {
  open: boolean; onClose: () => void; onUnderneath: () => void; onInside: () => void;
}) {
  return (
    <div>
      <button type="button" onClick={onUnderneath}>Under the sheet</button>
      {open && (
        <ModalSheet title="Preview" closeLabel="Close" onClose={onClose}>
          <button type="button" onClick={onInside}>Inside action</button>
          <button type="button">Second</button>
        </ModalSheet>
      )}
    </div>
  );
}

function setup(open = true) {
  const spies = { onClose: jest.fn(), onUnderneath: jest.fn(), onInside: jest.fn() };
  const utils = render(<Page open={open} {...spies} />);
  return { ...spies, ...utils };
}

test('renders a labelled modal dialog into <body>', () => {
  const { container } = setup();
  const dialog = screen.getByRole('dialog', { name: 'Preview' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(container).not.toContainElement(dialog);
  expect(document.body).toContainElement(dialog);
});

test('one tap on the backdrop closes it, and nothing underneath is activated', () => {
  const s = setup();
  fireEvent.click(screen.getByTestId('modal-backdrop'));
  expect(s.onClose).toHaveBeenCalledTimes(1);
  expect(s.onUnderneath).not.toHaveBeenCalled();
});

test('the close button and Escape close it', () => {
  const s = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(s.onClose).toHaveBeenCalledTimes(2);
});

test('buttons inside keep their own action and do not close it', () => {
  const s = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Inside action' }));
  expect(s.onInside).toHaveBeenCalledTimes(1);
  expect(s.onClose).not.toHaveBeenCalled();
});

test('focus moves into the sheet and returns to where it was on close', () => {
  const spies = { onClose: jest.fn(), onUnderneath: jest.fn(), onInside: jest.fn() };
  const { rerender } = render(<Page open={false} {...spies} />);
  const under = screen.getByRole('button', { name: 'Under the sheet' });
  under.focus();
  rerender(<Page open {...spies} />);
  expect(screen.getByRole('dialog')).toHaveFocus();
  rerender(<Page open={false} {...spies} />);
  expect(under).toHaveFocus();
});

test('the page behind does not scroll while open; its scroll and overflow are restored', () => {
  const scrollTo = jest.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  Object.defineProperty(window, 'scrollY', { value: 240, configurable: true, writable: true });
  document.body.style.overflow = 'auto';
  const spies = { onClose: jest.fn(), onUnderneath: jest.fn(), onInside: jest.fn() };
  const { rerender } = render(<Page open {...spies} />);
  expect(document.body.style.overflow).toBe('hidden');
  (window as { scrollY: number }).scrollY = 0; // e.g. iOS jumped to the top
  rerender(<Page open={false} {...spies} />);
  expect(document.body.style.overflow).toBe('auto');
  expect(scrollTo).toHaveBeenCalledWith(0, 240);
});

test('Tab stays inside the sheet', () => {
  setup();
  const second = screen.getByRole('button', { name: 'Second' });
  second.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
});

// Static check of the stylesheets (jsdom has no layout).
test('stylesheet: above the bottom navigation, full-viewport backdrop, inner scrolling, safe areas', () => {
  const sheet = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ModalSheet.css'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'AppShell.css'), 'utf8');
  const rule = (css: string, sel: string) => {
    const m = new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`no rule ${sel}`);
    return m[1];
  };
  const z = (body: string) => Number(/z-index: (\d+)/.exec(body)?.[1]);
  expect(z(rule(sheet, '.modal-sheet'))).toBeGreaterThan(z(rule(shell, '.bottom-nav')));
  expect(rule(sheet, '.modal-sheet')).toMatch(/position: fixed;[\s\S]*inset: 0;/);
  expect(rule(sheet, '.modal-sheet__backdrop')).toMatch(/inset: 0;/);
  const body = rule(sheet, '.modal-sheet__body');
  expect(body).toMatch(/overflow-y: auto;/);
  expect(body).toMatch(/overscroll-behavior: contain;/);
  expect(body).toMatch(/safe-area-inset-bottom/);
  expect(rule(sheet, '.modal-sheet')).toMatch(/safe-area-inset-top/);
});
