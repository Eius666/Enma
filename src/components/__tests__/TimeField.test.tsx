import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeField } from '../ui/TimeField';

// The shared time row (habit reminder, task time).

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return <TimeField label="Время" value={value} onChange={setValue} emptyText="Не задано" clearLabel="Убрать время" />;
}

test('the label names the native time input, so a tap on the row reaches it', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Время') as HTMLInputElement;
  expect(input.type).toBe('time');
  expect(input.labels).toHaveLength(1);
  expect(input.labels![0]).toHaveTextContent('Время');
});

test('empty: shows the empty text and no remove button; a value replaces it', () => {
  render(<Harness />);
  expect(screen.getByText('Не задано')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Убрать время' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Время'), { target: { value: '06:05' } });
  expect(screen.getByText('06:05')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Убрать время' }));
  expect(screen.getByText('Не задано')).toBeTruthy();
  expect((screen.getByLabelText('Время') as HTMLInputElement).value).toBe('');
});

// Static check of the stylesheet (jsdom has no layout): the native input must
// cover the whole row with a finger-sized height. A collapsed empty
// <input type="time"> is what made the habit reminder untappable on iPhone.
test('stylesheet: the invisible native input covers the whole, finger-sized row', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'TimeField.css'), 'utf8');
  const rule = (sel: string) => {
    const m = new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`no rule ${sel}`);
    return m[1];
  };
  const input = rule('.time-field__input');
  expect(input).toMatch(/position: absolute;/);
  expect(input).toMatch(/inset: 0;/);
  expect(input).toMatch(/width: 100%;/);
  expect(input).toMatch(/height: 100%;/);
  expect(input).not.toMatch(/display: none|visibility: hidden|pointer-events: none/);
  const main = rule('.time-field__main');
  expect(main).toMatch(/position: relative;/);
  const minHeight = Number(/min-height: (\d+)px;/.exec(main)?.[1]);
  expect(minHeight).toBeGreaterThanOrEqual(44);
});
