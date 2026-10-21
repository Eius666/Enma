import React, { Suspense } from 'react';
import type SettingsScreen from './SettingsScreen';

// Settings (and with it TonConnect, ~124 KB gzip) is loaded the first time the
// tab is opened rather than at application start. The prefetch hint lets the
// browser fetch the chunk during idle time so opening Settings is still quick.
const SettingsWithTon = React.lazy(
  () => import(/* webpackPrefetch: true */ './SettingsWithTon')
);

type SettingsProps = React.ComponentProps<typeof SettingsScreen>;

const LazySettings: React.FC<SettingsProps> = props => (
  <Suspense
    fallback={<div aria-busy="true" data-testid="settings-loading" style={{ minHeight: '40vh' }} />}
  >
    <SettingsWithTon {...props} />
  </Suspense>
);

export default LazySettings;
