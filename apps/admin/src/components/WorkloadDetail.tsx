import { useEffect, useRef, useState } from 'react';
import { fetchWorkloadDetail, type WorkloadItem, type WorkloadMetric } from '../api';

const workDays = (row: WorkloadItem) => row.arrived_on && row.shipped_on
  ? Math.round((Date.parse(row.shipped_on + 'T00:00:00Z') - Date.parse(row.arrived_on + 'T00:00:00Z')) / 86400000) : null;

export default function WorkloadDetail({ delivererId, name, metric, onClose }: {
  delivererId: string; name: string; metric: WorkloadMetric; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<WorkloadItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setRows(null); setError('');
    fetchWorkloadDetail(delivererId, metric).then(result => { if (active) setRows(result); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [delivererId, metric]);
  const days = (rows ?? []).map(workDays).filter((day): day is number => day !== null);
  return <dialog ref={dialog} className="monthly-detail" aria-labelledby="workload-detail-title" onCancel={onClose}>
    <div className="toolbar"><h2 id="workload-detail-title">{name} · {metric}の詳細</h2><span style={{ flex: 1 }} /><button className="btn" onClick={onClose} autoFocus>閉じる</button></div>
    {error ? <div className="error" role="alert">{error}</div> : rows === null ? <p>読み込み中…</p> : <>
      <p>{rows.length}件{metric === '平均作業日数' && ` · 平均 ${days.length ? (days.reduce((sum, day) => sum + day, 0) / days.length).toFixed(1) : '—'}日`}</p>
      {metric === '平均作業日数' && <p className="sub">入荷日から出荷日までの日数。入荷日・出荷日が登録された全期間の商品が対象です。</p>}
      {rows.length === 0 ? <p>該当する商品はありません。</p> : <div className="scroll"><table>
        <thead><tr><th>通番号</th><th>商品・仕入先</th><th>状況</th><th>仕入日</th><th>入荷日</th><th>出荷日</th><th className="num">作業日数</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id}>
          <td>{(rows[index - 1]?.sku.match(/^([0-9]+[a-z]*)[-_]/i)?.[1].toUpperCase() ?? String(rows[index - 1]?.lot_seq)) !== (row.sku.match(/^([0-9]+[a-z]*)[-_]/i)?.[1].toUpperCase() ?? String(row.lot_seq)) ? (row.sku.match(/^([0-9]+[a-z]*)[-_]/i)?.[1].toUpperCase() ?? row.lot_seq) : ''}</td>
          <td className="detail-description">{row.title}<div className="expense-hint">{row.marketplace} · {row.sku}</div></td>
          <td>{row.status}</td><td>{row.purchased_at || '—'}</td><td>{row.arrived_on || '—'}</td><td>{row.shipped_on || '—'}</td><td className="num">{workDays(row) ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </dialog>;
}
