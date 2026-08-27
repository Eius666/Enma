import { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api/ai';

export function getAdminKey(): string {
  return sessionStorage.getItem('admin_key') || '';
}

export function setAdminKey(key: string) {
  sessionStorage.setItem('admin_key', key);
}

export function clearAdminKey() {
  sessionStorage.removeItem('admin_key');
}

export async function adminCall<T = unknown>(action: string, body: object = {}): Promise<T> {
  const key = getAdminKey();
  const res = await fetch(`${API_BASE}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    clearAdminKey();
    window.location.reload();
    throw new Error('forbidden');
  }
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAdminApi<T = unknown>(action: string, body: object = {}): ApiState<T> {
  const [data, setData]     = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [tick, setTick]     = useState(0);

  const bodyStr = JSON.stringify(body);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminCall<T>(action, JSON.parse(bodyStr))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, bodyStr, tick]);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  return { data, loading, error, refetch };
}
