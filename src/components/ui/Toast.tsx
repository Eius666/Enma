import React, { createContext, useCallback, useContext, useState } from 'react';
import './Toast.css';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  show: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;
const nextId = () => `toast-${++counter}`;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = nextId();
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-container" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.variant}`} role="alert">
            <span className="toast__message">{t.message}</span>
            <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
