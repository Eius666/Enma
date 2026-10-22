import { preloadTabs } from '../tabs/LazyTabs';

// The background preload of the tab chunks must never fail the app: a chunk
// that cannot be loaded now (no network, a newer deployment) is simply loaded
// again when its tab is opened.

jest.mock('../tabs/CalendarTab', () => ({ CalendarTab: () => null }));
jest.mock('../tabs/NotesTab', () => ({ NotesTab: () => null }));
jest.mock('../tabs/HabitsTab', () => ({ HabitsTab: () => null }));
jest.mock('../tabs/FinanceTab', () => { throw new Error('ChunkLoadError'); });

test('preloadTabs resolves even when one of the chunks cannot be loaded', async () => {
  await expect(preloadTabs()).resolves.toBeUndefined();
});
