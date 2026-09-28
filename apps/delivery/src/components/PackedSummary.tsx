import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';

interface Packed { id: string; lot_seq: number; purchased_at: string; packed_on: string; title: string; sku: string }

export default function PackedSummary({ staffId }: { staffId: string }) {
  const [rows, setRows] = useState<Packed[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setRows([]);
    void (async () => {
      const { data, error } = await getSupabase().rpc('packed_product_summary', { p_staff: staffId, p_month: null });
      if (error) throw error;
      if (active) setRows(data as Packed[]);
    })()
      .catch(e => { if (active) setError(e.message ?? String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [staffId]);

  return <section className="packed-summary no-print">
    <h3>納品実績</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p>読み込み中…</p> : !error && <div className="packed-summary-scroll">
      <table><thead><tr><th>通番号</th><th>購入日</th><th>梱包日</th><th>SKU</th><th>商品名</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><td>{row.lot_seq}</td><td>{row.purchased_at?.slice(0, 10) ?? '—'}</td><td>{row.packed_on?.slice(0, 10)}</td><td>{row.sku}</td><td>{row.title}</td></tr>)}</tbody>
      </table>
      {!rows.length && <p>該当する商品はありません。</p>}
    </div>}
  </section>;
}
