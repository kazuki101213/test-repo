import ColoredLabel from './ColoredLabel';
import { productModelText } from '@bussan/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchWorkloadDetail, type DashboardScope, type WorkloadItem, type WorkloadMetric } from '../api';
import { productSerial } from '../inventory';

export default function WorkloadDetail({ delivererId, name, metric, scope, scopeLabel, onClose }: {
  delivererId: string; name: string; metric: WorkloadMetric; scope: DashboardScope; scopeLabel: string; onClose: () => void;
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
    fetchWorkloadDetail(delivererId, metric, scope).then(result => { if (active) setRows(result); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [delivererId, metric, scope]);
  return <dialog ref={dialog} className="monthly-detail" aria-labelledby="workload-detail-title" onCancel={onClose}>
    <div className="toolbar"><h2 id="workload-detail-title">{name} · {scopeLabel} · {metric.label}の詳細</h2><span style={{ flex: 1 }} /><button className="btn" onClick={onClose} autoFocus>閉じる</button></div>
    {error ? <div className="error" role="alert">{error}</div> : rows === null ? <p>読み込み中…</p> : <>
      <p>{rows.length}点</p>
      {rows.length === 0 ? <p>該当する商品はありません。</p> : <div className="scroll"><table>
        <thead><tr><th>通番号</th><th>型番・SKU</th><th>販売先</th><th>販売状態</th><th>仕入日</th><th>作業完了日</th><th>出荷日</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{productSerial(row.sku, row.lot_seq)}</td>
          <td className="detail-description">{productModelText(row)}<div className="expense-hint">{row.sku}</div></td>
          <td><ColoredLabel value={row.sales_channel || '—'} /></td>
          <td>{row.status}</td><td>{row.purchased_at || '—'}</td><td>{row.packed_on || '—'}</td><td>{row.shipped_on || '—'}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </dialog>;
}
