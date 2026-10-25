import { useCallback, useEffect, useRef, useState } from 'react';
import type { PurchaseDraft } from '@bussan/shared';

function message(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') return cause.message;
  return '通信状況を確認して、もう一度更新してください。';
}

export function usePurchaseDrafts(fetchDrafts: () => Promise<PurchaseDraft[]>, visible = true) {
  const [rows, setRows] = useState<PurchaseDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<{ at: string; count: number } | null>(null);
  const pending = useRef(false);
  const lastCheck = useRef<number | null>(null);

  const refresh = useCallback(async (manual = false) => {
    if (pending.current) return;
    pending.current = true;
    lastCheck.current = Date.now();
    setLoading(true);
    setError(null);
    setUpdated(null);
    try {
      const next = await fetchDrafts();
      setRows(next);
      if (manual) setUpdated({ at: new Date().toLocaleTimeString('ja-JP', { hour12: false }), count: next.length });
    } catch (cause) {
      // Preserve the currently displayed list when a refresh fails.
      setError(message(cause));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, [fetchDrafts]);

  const refreshIfStale = useCallback(async () => {
    if (document.visibilityState !== 'visible' ||
      (lastCheck.current !== null && Date.now() - lastCheck.current < 60000)) return;
    await refresh();
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    void refreshIfStale();
    const returned = () => { void refreshIfStale(); };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => {
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, [visible, refreshIfStale]);
  return { rows, setRows, loading, error, setError, updated, refresh };
}
