import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

if (window.location.pathname.startsWith('/admin')) {
  import('./admin/App').then(({ default: AdminApp }) => {
    root.render(<AdminApp />);
  });
} else {
  Promise.all([
    import('./App'),
    import('@tonconnect/ui-react'),
  ]).then(([{ default: App }, { TonConnectUIProvider }]) => {
    // Falls back to the current origin so this resolves correctly on whichever
    // domain actually served the app (old or new), instead of a hardcoded one.
    const TONCONNECT_MANIFEST_URL =
      process.env.REACT_APP_TONCONNECT_MANIFEST ||
      `${window.location.origin}/tonconnect-manifest.json`;
    root.render(
      <TonConnectUIProvider manifestUrl={TONCONNECT_MANIFEST_URL}>
        <App />
      </TonConnectUIProvider>
    );
  });
}

reportWebVitals();
