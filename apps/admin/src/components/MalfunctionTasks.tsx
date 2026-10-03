import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';

interface MalfunctionTask {
  id: string; sku: string; lot_seq: number; title: string; malfunction_comment: string;
  malfunction_reported_at: string; malfunction_reported_by: string | null;
}

export default function MalfunctionTasks() {
  const [rows, setRows] = useState<MalfunctionTask[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const { data, error: queryError } = await getSupabase().from('items')
      .select('id,sku,lot_seq,title,malfunction_comment,malfunction_reported_at,malfunction_reported_by')
      .eq('malfunction_reported', true).is('malfunction_resolved_at', null)
      .order('malfunction_reported_at', { ascending: false });
    if (queryError) throw queryError;
    const tasks = (data ?? []) as MalfunctionTask[];
    setRows(tasks);
    const staffIds = [...new Set(tasks.map(row => row.malfunction_reported_by).filter((id): id is string => !!id))];
    if (staffIds.length) {
      const { data: staff, error: staffError } = await getSupabase().from('staff').select('id,name').in('id', staffIds);
      if (staffError) throw staffError;
      setNames(new Map((staff ?? []).map(person => [person.id as string, person.name as string])));
    } else setNames(new Map());
    setError('');
  }

  useEffect(() => {
    let active = true;
    const load = () => { void refresh().catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); }); };
    load();
    const timer = window.setInterval(load, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function resolve(id: string) {
    setBusy(id); setError('');
    try {
      const { error: rpcError } = await getSupabase().rpc('resolve_item_malfunction', { p_item_id: id });
      if (rpcError) throw rpcError;
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return <>
    {error && <li className="error" role="alert">動作不良タスク：{error}</li>}
    {rows.map(row => <li key={`malfunction-${row.id}`} className="malfunction-task-row">
      <div><strong>動作不良 · {row.title}（{row.lot_seq}）</strong><small>SKU {row.sku} · {names.get(row.malfunction_reported_by ?? '') ?? '担当者不明'} · {new Date(row.malfunction_reported_at).toLocaleString('ja-JP')}</small>
        <p style={{ whiteSpace: 'pre-wrap' }}>{row.malfunction_comment}</p>
      </div>
      <button className="btn" disabled={busy !== null} onClick={() => void resolve(row.id)}>{busy === row.id ? '更新中…' : '対応完了'}</button>
    </li>)}
  </>;
}
