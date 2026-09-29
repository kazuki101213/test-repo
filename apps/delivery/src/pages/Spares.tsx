import { useEffect, useState } from 'react';
import { fetchSpareAccessories, spareState, yen } from '@bussan/shared';
import type { SpareAccessory, Staff } from '@bussan/shared';

export default function Spares({ staff }: { staff: Staff }) {
  const [rows, setRows] = useState<SpareAccessory[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    fetchSpareAccessories(staff.role === 'admin' ? undefined : staff.id)
      .then(data => { if (active) setRows(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [staff.id, staff.role]);

  const shown = rows.filter(row => [row.title, row.source_sku, row.marketplace_item_id, row.tracking_no, row.owner_name]
    .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <section className="card">
    <h2>予備一覧</h2>
    <input type="search" aria-label="予備を検索" placeholder="品名・SKU・商品ID・追跡番号" value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p>読み込み中…</p> : shown.length === 0 ? <p className="empty">予備はありません。</p> :
      <div className="spare-list">{shown.map(row => <div className="spare-row" key={row.id}>
        <div><strong>{row.title}</strong> <span className="badge">{spareState(row)}</span></div>
        <div>保管担当：{row.owner_name || '未設定'}</div>
        <div>購入日：{row.purchased_at || '—'}　仕入金額：{yen(row.cost_amount)}</div>
        {row.source_sku && <div>SKU：{row.source_sku}</div>}
        {row.marketplace_item_id && <div>商品ID：{row.marketplace_item_id}</div>}
        {row.tracking_no && <div>追跡番号：{row.tracking_no}</div>}
        {row.usage_note && <div>利用記録：{row.usage_note}</div>}
      </div>)}</div>}
  </section>;
}
