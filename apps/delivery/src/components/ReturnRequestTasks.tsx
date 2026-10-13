import { useEffect, useState } from 'react';
import type { DeliveryReturnRequestTask } from '@bussan/shared';
import { completeReturnRequestTask, fetchReturnRequestTasks } from '../api';

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : '返送依頼作成タスクを処理できませんでした。';

export default function ReturnRequestTasks() {
  const [rows, setRows] = useState<DeliveryReturnRequestTask[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const next = await fetchReturnRequestTasks(); if (active) { setRows(next); setError(''); } }
      catch (cause) { if (active) setError(messageOf(cause)); }
    };
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onVisible, 30000);
    window.addEventListener('focus', onVisible); document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  async function complete(id: string) {
    if (busy) return;
    setBusy(id); setError('');
    try { await completeReturnRequestTask(id); setRows(current => current.filter(row => row.id !== id)); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  }
  if (error) return <ul className="invoice-task-rows" aria-label="返送依頼作成"><li><p className="error" role="alert">{error}</p></li></ul>;
  if (!rows.length) return null;
  return <ul className="invoice-task-rows" aria-label="返送依頼作成">
    {rows.map(row => <li key={row.id} className="return-request-task-row">
      <div className="spare-shipping-heading"><span>【{row.lot_seq}】返送依頼作成</span>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void complete(row.id)}>完了</button></div>
      <div className="spare-shipping-details"><span>SKU：{row.sku}</span><span>型番：{row.model_no || '未登録'}</span><span>ASIN：{row.asin || '未登録'}</span></div>
    </li>)}
  </ul>;
}
