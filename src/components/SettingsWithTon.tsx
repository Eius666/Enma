import React from 'react';
import { TonConnectUIProvider } from '@tonconnect/ui-react';
import SettingsScreen from './SettingsScreen';

// The Settings screen hosts the TON wallet button and the subscription panel,
// the only places that use TonConnect. The provider therefore lives here and
// is loaded together with this module (see LazySettings), instead of being
// bundled into the app's startup path. TonConnectUIProvider keeps a
// module-level singleton, so leaving and re-opening Settings reuses the same
// connection.
type SettingsProps = React.ComponentProps<typeof SettingsScreen>;

// Falls back to the current origin so this resolves correctly on whichever
// domain actually served the app, instead of a hardcoded one.
const getManifestUrl = () =>
  process.env.REACT_APP_TONCONNECT_MANIFEST ||
  `${window.location.origin}/tonconnect-manifest.json`;

const SettingsWithTon: React.FC<SettingsProps> = props => (
  <TonConnectUIProvider manifestUrl={getManifestUrl()}>
    <SettingsScreen {...props} />
  </TonConnectUIProvider>
);

export default SettingsWithTon;
