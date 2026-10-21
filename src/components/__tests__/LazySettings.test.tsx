import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';

const mockLoads = { tonconnect: 0, lastManifest: '' };

jest.mock('@tonconnect/ui-react', () => {
  mockLoads.tonconnect += 1; // counts how many times the library module is evaluated
  return {
    TonConnectUIProvider: ({ manifestUrl, children }: { manifestUrl: string; children: React.ReactNode }) => {
      mockLoads.lastManifest = manifestUrl;
      return <div data-testid="ton-provider">{children}</div>;
    },
  };
});

jest.mock('../SettingsScreen', () => ({
  __esModule: true,
  default: ({ language }: { language: string }) => <div data-testid="settings-stub">settings:{language}</div>,
}));

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('lazy Settings / TonConnect loading', () => {
  test('importing the lazy wrapper does not load TonConnect', async () => {
    const mod = await import('../LazySettings');
    expect(typeof mod.default).toBe('function');
    expect(mockLoads.tonconnect).toBe(0);
  });

  test('rendering it shows a placeholder first, then loads Settings inside the TON provider', async () => {
    const { default: LazySettings } = await import('../LazySettings');
    const props = { language: 'en' } as unknown as React.ComponentProps<typeof LazySettings>;
    render(<LazySettings {...props} />);
    expect(screen.getByTestId('settings-loading')).toBeTruthy();
    expect(await screen.findByTestId('settings-stub')).toBeTruthy();
    expect(screen.getByTestId('ton-provider').contains(screen.getByTestId('settings-stub'))).toBe(true);
    expect(mockLoads.tonconnect).toBe(1);
    expect(mockLoads.lastManifest.endsWith('/tonconnect-manifest.json')).toBe(true);
  });

  test('props reach the Settings screen unchanged', async () => {
    const { default: LazySettings } = await import('../LazySettings');
    render(<LazySettings {...({ language: 'ru' } as unknown as React.ComponentProps<typeof LazySettings>)} />);
    expect((await screen.findByTestId('settings-stub')).textContent).toBe('settings:ru');
  });

  test('the startup path (index.tsx, App.tsx) has no static import of TonConnect or Settings', () => {
    for (const file of ['index.tsx', 'App.tsx']) {
      const source = read(file);
      expect(source).not.toMatch(/from\s+['"]@tonconnect\//);
      expect(source).not.toMatch(/import\(\s*['"]@tonconnect\//);
      expect(source).not.toMatch(/from\s+['"]\.\/components\/SettingsScreen['"]/);
    }
    expect(read('App.tsx')).toMatch(/from\s+'\.\/components\/LazySettings'/);
  });
});
