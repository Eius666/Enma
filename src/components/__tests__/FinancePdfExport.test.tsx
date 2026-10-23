import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { User } from 'firebase/auth';
import FinanceList from '../FinanceList';
import SettingsScreen from '../SettingsScreen';
import { FinancePdfButton } from '../FinancePdfExport';
import type { Subscription } from '../../subscription';

// BUG-12: the finance PDF report from two places — a compact button in Finance
// (only when the server grants the export) and a Settings block every plan
// sees — both on the one export (src/lib/financePdfExport.ts). The server, the
// subscription documents and aiUsage/{uid} are fakes shaped like the real ones.

jest.mock('@tonconnect/ui-react', () => ({
  useTonConnectUI: () => [{ openModal: () => {}, disconnect: () => {}, sendTransaction: async () => ({}) }],
  useTonAddress: () => '',
  useTonWallet: () => null,
}));
jest.mock('../../firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: async () => ({ exists: () => true, data: () => ({ trialUsed: true }) }),
  setDoc: async () => undefined,
  serverTimestamp: () => 'TS',
  collection: (_db: unknown, name: string) => ({ path: name }),
  query: (ref: unknown) => ref,
  where: () => ({}),
  onSnapshot: (_q: unknown, next: (s: { docs: unknown[] }) => void) => { setTimeout(() => next({ docs: [] }), 0); return () => {}; },
}));
const mockAiUsage: { pdfReports: number | 'error' | null; listeners: number } = { pdfReports: 0, listeners: 0 };
jest.mock('../../lib/usageCounters', () => ({
  subscribeAiUsage: (_uid: string, cb: (u: { textRequests: number; imageRequests: number; pdfReports: number }) => void, onError?: () => void) => {
    mockAiUsage.listeners += 1;
    const value = mockAiUsage.pdfReports;
    setTimeout(() => {
      if (value === 'error') onError?.();
      else if (value !== null) cb({ textRequests: 0, imageRequests: 0, pdfReports: value });
    }, 0);
    return () => {};
  },
  subscribeFreeUsage: () => () => {},
}));
jest.mock('../../lib/fetchWithTimeout', () => ({
  fetchWithTimeout: async () => ({ json: async () => ({ ok: false }) }),
}));

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const trial = (): Subscription => ({
  plan: 'free', trialPlan: 'premium', period: 'month', status: 'active', paymentMethod: 'trial',
  startDate: iso(Date.now() - DAY), endDate: iso(Date.now() + 6 * DAY), endDateMs: Date.now() + 6 * DAY, trialEndDate: iso(Date.now() + 6 * DAY),
} as unknown as Subscription);
const paid = (plan: 'pro' | 'premium', daysLeft = 20, extra: Record<string, unknown> = {}): Subscription => ({
  plan, status: 'active', period: 'month', startDate: iso(Date.now() - DAY),
  endDate: iso(Date.now() + daysLeft * DAY), endDateMs: Date.now() + daysLeft * DAY, ...extra,
} as unknown as Subscription);
const expiredTrial = (): Subscription => ({ ...trial(), endDate: iso(Date.now() - DAY), endDateMs: Date.now() - DAY, trialEndDate: iso(Date.now() - DAY) } as Subscription);

const user = { uid: 'u1', email: 'u1@example.com', getIdToken: async () => 'id-token-1' } as unknown as User;

type Answer = () => Promise<unknown>;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let pdfAnswer: Answer;
const pdfOk: Answer = async () => ({
  ok: true, status: 200,
  headers: { get: (h: string) => (h === 'Content-Disposition' ? 'attachment; filename="ENMA-report-2026-10.pdf"' : null) },
  blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
});
const pdfError = (status: number, body: Record<string, unknown>): Answer => async () => ({ ok: false, status, json: async () => body });

let downloads: string[] = [];
beforeEach(() => {
  mockAiUsage.pdfReports = 0;
  mockAiUsage.listeners = 0;
  fetchCalls = [];
  downloads = [];
  pdfAnswer = pdfOk;
  global.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return pdfAnswer();
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => 'blob:report';
  URL.revokeObjectURL = () => undefined;
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(() => { jest.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const pdfCalls = () => fetchCalls.filter(c => c.url === '/api/ai/exportFinancePdf');
const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

async function showFinance(subscription: Subscription | null, subscriptionLoaded = true) {
  render(
    <FinanceList
      language="ru" currency="RUB" rates={{}} categories={[]} transactions={[]} user={user}
      reportButton={<FinancePdfButton language="ru" user={user} subscription={subscription} subscriptionLoaded={subscriptionLoaded} />}
      onOpenEditor={() => undefined}
    />,
  );
  await settle();
}

async function showSettings(subscription: Subscription | null, subscriptionLoaded = true) {
  render(
    <SettingsScreen
      language="ru" theme="dark" currency="RUB" user={user} subscription={subscription} subscriptionLoaded={subscriptionLoaded}
      ratesStatus="idle" ratesUpdatedAt={null} banks={[]}
      onLanguageChange={() => {}} onCurrencyChange={() => {}} onThemeToggle={() => {}} onRefreshRates={() => {}}
      onSubscriptionChange={() => {}} onBanksChange={() => {}} onSignOut={() => {}}
    />,
  );
  await settle();
}

// ── Finance tab ─────────────────────────────────────────────────────────────

test('Finance: the report button sits between the transaction search and the category chips', async () => {
  await showFinance(paid('premium'));
  const search = screen.getByPlaceholderText('Поиск операций…');
  const button = screen.getByRole('button', { name: 'Финансовый отчёт' });
  const allChip = screen.getByRole('button', { name: 'Все' });
  expect(follows(search, button)).toBe(true);
  expect(follows(button, allChip)).toBe(true);
});

test('Finance: the report button is its own row under the search — the PDF icon and the label, nothing else', async () => {
  await showFinance(paid('premium'));
  const button = screen.getByRole('button', { name: 'Финансовый отчёт' });
  expect(button).toHaveClass('fin-pdf__btn');
  // The search field's wrapper closes, then the report row opens with the button.
  expect(document.body.innerHTML).toMatch(/<div class="fin-list__search-wrap">(?:(?!<\/div>)[\s\S])*<\/div><div class="fin-pdf"><button type="button" class="fin-pdf__btn"/);
  // Inside the button: the PDF icon (hidden from screen readers), then the label — nothing else.
  expect(button.innerHTML).toMatch(/^<svg[^>]*class="fin-pdf__icon"[^>]*aria-hidden="true"[^>]*>[\s\S]*<\/svg><span class="fin-pdf__label">Финансовый отчёт<\/span>$/);
});

// jsdom does no layout, so the sizing rules are checked in the stylesheet
// itself (the rendered sizes at 320/375/390 px are compared in a browser).
test('Finance: the report button stylesheet makes it full width, at least 48px tall, without overflowing', () => {
  const css: string = jest.requireActual<typeof import('fs')>('fs').readFileSync(
    jest.requireActual<typeof import('path')>('path').join(__dirname, '..', 'FinancePdfExport.css'), 'utf8');
  const rule = (selector: string): Record<string, string> => {
    const body = new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1];
    if (body === undefined) throw new Error(`no rule for ${selector}`);
    return Object.fromEntries(body.split(';').map(d => d.split(':').map(s => s.trim())).filter(([k, v]) => k && v));
  };
  const btn = rule('.fin-pdf__btn');
  expect(btn).toMatchObject({ display: 'flex', width: '100%', 'box-sizing': 'border-box', 'align-items': 'center', 'justify-content': 'center' });
  expect(parseFloat(btn['min-height'])).toBeGreaterThanOrEqual(48);
  expect(btn).not.toHaveProperty('white-space');
  expect(btn).not.toHaveProperty('max-width');
  expect(rule('.fin-pdf__icon')['flex-shrink']).toBe('0');
  expect(rule('.fin-pdf__label')).toMatchObject({ 'min-width': '0', 'overflow-wrap': 'anywhere' });
  // No fixed pixel width anywhere in the Finance tab part of the file.
  const financePart = css.slice(0, css.indexOf('/* — Settings block — */'));
  expect(financePart).not.toMatch(/(?:^|[\s;{])(?:min-)?width:\s*\d+px/);
});

test.each([
  ['Free (no subscription)', null],
  ['Pro', paid('pro')],
  ['an ended trial', expiredTrial()],
  ['Pro bought during the trial (the server grants Pro)', paid('pro', 30, { trialPlan: 'premium', trialEndDate: iso(Date.now() + 3 * DAY) })],
  ['a cancelled Premium', paid('premium', 20, { status: 'cancelled' })],
])('Finance: no report button for %s', async (_name, sub) => {
  await showFinance(sub as Subscription | null);
  expect(screen.queryByRole('button', { name: 'Финансовый отчёт' })).toBeNull();
  expect(mockAiUsage.listeners).toBe(0);
});

test('Finance: no button while the subscription is still loading, even for a Premium document', async () => {
  await showFinance(paid('premium'), false);
  expect(screen.queryByRole('button', { name: 'Финансовый отчёт' })).toBeNull();
});

test('Finance: a running Premium trial gets the button (the server grants the export)', async () => {
  await showFinance(trial());
  expect(screen.getByRole('button', { name: 'Финансовый отчёт' })).toBeEnabled();
});

test('Finance: a tap downloads the report through the authenticated export; a second tap meanwhile starts nothing', async () => {
  let release: () => void = () => undefined;
  pdfAnswer = () => new Promise(r => { release = () => r(pdfOk()); });
  await showFinance(paid('premium'));
  const button = screen.getByRole('button', { name: 'Финансовый отчёт' });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Формируем отчёт…' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Формируем отчёт…' }));
  await act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
  await waitFor(() => expect(downloads).toEqual(['ENMA-report-2026-10.pdf']));
  expect(pdfCalls()).toHaveLength(1);
  expect(pdfCalls()[0].init.method).toBe('POST');
  expect((pdfCalls()[0].init.headers as Record<string, string>).Authorization).toBe('Bearer id-token-1');
  expect(screen.getByRole('button', { name: 'Финансовый отчёт' })).toBeEnabled();
});

test('Finance: rendering again never asks the server for a report', async () => {
  await showFinance(paid('premium'));
  await showFinance(paid('premium'));
  expect(pdfCalls()).toHaveLength(0);
});

test('Finance: an exhausted month disables the button and says so', async () => {
  mockAiUsage.pdfReports = 10;
  await showFinance(paid('premium'));
  expect(screen.getByRole('button', { name: 'Финансовый отчёт' })).toBeDisabled();
  expect(screen.getByText('Лимит PDF-отчётов на этот месяц исчерпан.')).toBeTruthy();
});

test('Finance: the server refusing for the monthly limit disables further tries', async () => {
  pdfAnswer = pdfError(429, { code: 'pdf_limit', plan: 'premium', used: 10, limit: 10, error: 'x' });
  await showFinance(paid('premium'));
  fireEvent.click(screen.getByRole('button', { name: 'Финансовый отчёт' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Лимит PDF-отчётов на этот месяц исчерпан.');
  expect(screen.getByRole('button', { name: 'Финансовый отчёт' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Финансовый отчёт' }));
  expect(pdfCalls()).toHaveLength(1);
});

// ── Settings ────────────────────────────────────────────────────────────────

test('Settings: the PDF block comes right after Preferences and before the next group', async () => {
  await showSettings(null);
  const prefs = screen.getByText('Предпочтения');
  const themeRow = screen.getByText('Тема');
  const heading = screen.getByRole('heading', { name: 'Финансовые PDF-отчёты' });
  const banks = screen.getByText('Банки и методы оплаты');
  expect(follows(prefs, themeRow) && follows(themeRow, heading) && follows(heading, banks)).toBe(true);
});

test.each([
  ['Free', null],
  ['Pro', paid('pro')],
  ['an ended trial', expiredTrial()],
])('Settings, %s: description, "Доступно с Premium" and an upgrade button to the existing subscription panel', async (_name, sub) => {
  await showSettings(sub as Subscription | null);
  expect(screen.getByText(/Доходы, расходы, категории, счета и цели/)).toBeTruthy();
  expect(screen.getByText('Доступно с Premium')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Скачать PDF-отчёт' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перейти на Premium' }));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Тарифы Enma')).toBeTruthy(); // the existing panel it scrolls to
  expect(pdfCalls()).toHaveLength(0);
});

test('Settings, Premium: download with the months remaining, from the same export', async () => {
  mockAiUsage.pdfReports = 3;
  await showSettings(paid('premium'));
  expect(screen.queryByText('Доступно с Premium')).toBeNull();
  expect(await screen.findByText('Осталось в этом месяце: 7 из 10')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF-отчёт' }));
  expect(await screen.findByText('Отчёт скачан')).toBeTruthy();
  expect(downloads).toEqual(['ENMA-report-2026-10.pdf']);
  expect(pdfCalls()).toHaveLength(1);
  expect((pdfCalls()[0].init.headers as Record<string, string>).Authorization).toBe('Bearer id-token-1');
});

test('Settings, Premium trial: the export is offered, as the server grants it', async () => {
  await showSettings(trial());
  expect(screen.getByRole('button', { name: 'Скачать PDF-отчёт' })).toBeEnabled();
});

test('Settings: while the subscription loads neither an offer nor a download is shown', async () => {
  await showSettings(paid('premium'), false);
  expect(screen.getByText('Проверяем тариф…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Скачать PDF-отчёт' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Перейти на Premium' })).toBeNull();
});

test('Settings: an exhausted month — the limit is shown and generation is not possible', async () => {
  mockAiUsage.pdfReports = 10;
  await showSettings(paid('premium'));
  expect(await screen.findByText('Лимит PDF-отчётов на этот месяц исчерпан.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Скачать PDF-отчёт' })).toBeDisabled();
});

test('Settings: when the usage cannot be read no remaining count is promised', async () => {
  mockAiUsage.pdfReports = 'error';
  await showSettings(paid('premium'));
  expect(screen.queryByText(/Осталось в этом месяце/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Скачать PDF-отчёт' })).toBeEnabled();
});

test.each([
  ['a server error keeps its message', pdfError(503, { code: 'FX_UNAVAILABLE', error: 'Курсы валют временно недоступны' }), 'Курсы валют временно недоступны'],
  ['a refusal for the plan', pdfError(429, { code: 'pdf_limit', plan: 'pro', error: 'x' }), 'PDF-отчёты доступны на тарифе Premium.'],
  ['a network failure', async () => { throw new TypeError('Failed to fetch'); }, 'Не удалось сформировать отчёт. Попробуйте ещё раз.'],
])('Settings: %s, and the button works again afterwards', async (_name, answer, message) => {
  pdfAnswer = answer as Answer;
  await showSettings(paid('premium'));
  fireEvent.click(screen.getByRole('button', { name: 'Скачать PDF-отчёт' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(downloads).toEqual([]);
  expect(screen.getByRole('button', { name: 'Скачать PDF-отчёт' })).toBeEnabled();
});

test('Settings: the old export button inside the subscription card is gone (one entry point per screen)', async () => {
  await showSettings(paid('premium'));
  expect(screen.queryByRole('button', { name: /Выгрузить полный финансовый отчёт/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Скачать PDF-отчёт' })).toHaveLength(1);
});
