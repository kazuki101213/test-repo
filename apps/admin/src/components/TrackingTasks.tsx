import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type TrackingTask = {
  id: string;
  marketplace: string;
  account_label: string;
  marketplace_item_id: string | null;
  sku: string | null;
  app_tracking_no: string | null;
  site_tracking_no: string | null;
  confirmation_status: string;
  details: string | null;
  state: string;
  created_at: string;
};

export default function TrackingTasks() {
  const [rows, setRows] = useState<TrackingTask[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { data, error: queryError } = await getSupabase().from('marketplace_tracking_tasks')
      .select('id,marketplace,account_label,marketplace_item_id,sku,app_tracking_no,site_tracking_no,confirmation_status,details,state,created_at')
      .eq('state', '未確認').order('created_at', { ascending: false }).limit(200);
    if (queryError) throw queryError;
    setRows((data ?? []) as TrackingTask[]);
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => void refresh().catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  async function markChecked(id: string) {
    setError('');
    const { error: updateError } = await getSupabase().from('marketplace_tracking_tasks')
      .update({ state: '確認済み', updated_at: new Date().toISOString() }).eq('id', id);
    if (updateError) { setError(updateError.message); return; }
    await refresh();
  }

  return <>
    {rows.map(row => <li key={row.id} className="tracking-task-row">
      <div className="tracking-task-content">
        <strong>{row.marketplace}・{row.account_label}　{row.confirmation_status}</strong>
        <small>サイト商品ID：{row.marketplace_item_id ?? '—'} ／ 在庫SKU：{row.sku ?? '—'}</small>
        <small>アプリ側：{row.app_tracking_no ?? '—'} ／ サイト側：{row.site_tracking_no ?? '—'}</small>
        {row.details && <small>{row.details}</small>}
      </div>
      <button className="btn" type="button" onClick={() => void markChecked(row.id)}>確認済みにする</button>
    </li>)}
    {error && <li className="error" role="alert">タスクを読み込めませんでした：{error}<button className="btn" type="button" onClick={() => void refresh().catch(e => setError(String(e)))}>再読み込み</button></li>}
  </>;
}
