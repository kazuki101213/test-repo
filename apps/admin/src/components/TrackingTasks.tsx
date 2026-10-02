import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type TrackingTask = {
  id: string;
  marketplace: string;
  account_label: string;
  marketplace_item_id: string;
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
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { data, error: queryError } = await getSupabase().from('marketplace_tracking_tasks')
      .select('id,marketplace,account_label,marketplace_item_id,sku,app_tracking_no,site_tracking_no,confirmation_status,details,state,created_at')
      .eq('state', showDone ? '確認済み' : '未確認').order('created_at', { ascending: false }).limit(200);
    if (queryError) throw queryError;
    setRows((data ?? []) as TrackingTask[]);
  }, [showDone]);

  useEffect(() => { void refresh().catch(e => setError(e instanceof Error ? e.message : String(e))); }, [refresh]);

  async function markChecked(id: string) {
    setError('');
    const { error: updateError } = await getSupabase().from('marketplace_tracking_tasks')
      .update({ state: '確認済み', updated_at: new Date().toISOString() }).eq('id', id);
    if (updateError) { setError(updateError.message); return; }
    await refresh();
  }

  return <section className="card tracking-tasks" aria-label="追跡番号確認タスク">
    <div className="toolbar"><h3>タスク</h3><span>{showDone ? '確認済み' : '未確認'} {rows.length}件</span>
      <select aria-label="追跡番号タスクの状態" value={showDone ? 'done' : 'open'} onChange={e => setShowDone(e.target.value === 'done')}>
        <option value="open">未確認</option><option value="done">確認済み</option>
      </select>
      <button className="btn" type="button" onClick={() => void refresh().catch(e => setError(String(e)))}>更新</button>
    </div>
    {error && <p className="error">{error}</p>}
    {rows.length === 0 ? <p className="empty">追跡番号の確認タスクはありません。</p> : <div className="scroll">
      <table><thead><tr><th>サイト・アカウント</th><th>サイトの商品ID</th><th>在庫SKU</th><th>アプリ側追跡番号</th><th>サイト側追跡番号</th><th>確認状況</th><th>操作</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{row.marketplace}<small>{row.account_label}</small></td><td>{row.marketplace_item_id}</td><td>{row.sku ?? '—'}</td>
          <td>{row.app_tracking_no ?? '—'}</td><td>{row.site_tracking_no ?? '—'}</td>
          <td>{row.confirmation_status}{row.details && <small>{row.details}</small>}</td>
          <td>{!showDone && <button className="btn" type="button" onClick={() => void markChecked(row.id)}>確認済みにする</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
