import React, { Suspense } from 'react';
import type SettingsScreen from './SettingsScreen';

// Settings (and with it TonConnect, ~124 KB gzip) is loaded the first time the
// tab is opened rather than at application start. There is no prefetch hint:
// Chromium acted on it as soon as the app chunk arrived, so this download
// competed with the start itself (WebKit, Telegram on iOS, ignores it anyway).
const SettingsWithTon = React.lazy(() => import('./SettingsWithTon'));

type SettingsProps = React.ComponentProps<typeof SettingsScreen>;

const LazySettings: React.FC<SettingsProps> = props => (
  <Suspense
    fallback={<div aria-busy="true" data-testid="settings-loading" style={{ minHeight: '40vh' }} />}
  >
    <SettingsWithTon {...props} />
  </Suspense>
);

export default LazySettings;
