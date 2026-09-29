import { useEffect, useState } from 'react';
import { fetchSpareAccessories, spareState, yen } from '@bussan/shared';
import type { SpareAccessory } from '@bussan/shared';

export default function Spares() {
  const [rows, setRows] = useState<SpareAccessory[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetchSpareAccessories().then(data => { if (active) setRows(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const filtered = rows.filter(row => [row.title, row.source_sku, row.owner_name, row.marketplace_item_id, row.tracking_no]
    .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <section className="card">
    <h2>予備一覧</h2>
    <label className="field"><span>検索</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="品名・担当者・商品ID" /></label>
    {error && <p className="error">{error}</p>}
    {loading ? <p>読み込み中…</p> : <div className="scroll"><table><thead><tr>
      <th>状態</th><th>保管担当</th><th>品名</th><th>購入日</th><th>仕入金額</th><th>SKU / 商品ID</th><th>追跡番号</th><th>利用記録</th>
    </tr></thead><tbody>{filtered.map(row => <tr key={row.id}>
      <td>{spareState(row)}</td><td>{row.owner_name || '未設定'}</td><td>{row.title}</td><td>{row.purchased_at || '—'}</td>
      <td>{yen(row.cost_amount)}</td><td>{row.source_sku || row.marketplace_item_id || '—'}</td>
      <td>{row.tracking_no || '—'}</td><td>{row.usage_note || (row.used_for_item_id ? '商品へ割当済み' : '—')}</td>
    </tr>)}</tbody></table></div>}
  </section>;
}
