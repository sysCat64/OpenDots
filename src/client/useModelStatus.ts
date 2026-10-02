import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelStatus } from '../shared/model-types';
import { api, ApiError } from './api';

// Keeps the model status current. Polls quickly while something is changing
// (signing in or out, the first check), slowly otherwise, and straight away when
// the owner comes back to this tab from the ChatGPT sign-in.
export function useModelStatus(enabled: boolean) {
  const [status, setStatus] = useState<ModelStatus>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await api<ModelStatus>('/model');
      if (alive.current) {
        setStatus(next);
        setError(undefined);
      }
    } catch (e) {
      // A locked workspace is handled by the app; anything else is worth showing.
      if (alive.current && !(e instanceof ApiError && e.status === 401))
        setError(
          e instanceof Error ? e.message : 'Could not read the model status.',
        );
    }
  }, []);
  const state = status?.chatgpt.state;
  const fast =
    state === 'signing_in' || state === 'signing_out' || state === 'checking';
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), fast ? 1500 : 5000);
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [enabled, fast, refresh]);
  return { status, error, refresh, setStatus };
}
