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
    const TONCONNECT_MANIFEST_URL =
      process.env.REACT_APP_TONCONNECT_MANIFEST ||
      'https://enma-silk.vercel.app/tonconnect-manifest.json';
    root.render(
      <TonConnectUIProvider manifestUrl={TONCONNECT_MANIFEST_URL}>
        <App />
      </TonConnectUIProvider>
    );
  });
}

reportWebVitals();
