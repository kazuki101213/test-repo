import { useCallback, useEffect, useRef, useState } from 'react';
import type { PurchaseDraft } from '@bussan/shared';

function message(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') return cause.message;
  return '通信状況を確認して、もう一度更新してください。';
}

export function usePurchaseDrafts(fetchDrafts: () => Promise<PurchaseDraft[]>) {
  const [rows, setRows] = useState<PurchaseDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<{ at: string; count: number } | null>(null);
  const pending = useRef(false);

  const refresh = useCallback(async (manual = false) => {
    if (pending.current) return;
    pending.current = true;
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

  useEffect(() => { void refresh(); }, [refresh]);
  return { rows, setRows, loading, error, setError, updated, refresh };
}
