import { useEffect, useMemo, useState } from 'react';
import { getSupabase, yen } from '@bussan/shared';

type Row = {
  order_item_id: string;
  order_id: string;
  ordered_at: string;
  order_on: string;
  order_status: string;
  sku: string | null;
  canonical_sku: string | null;
  quantity: number | null;
  item_price: number | null;
  app_sold_on: string | null;
  app_sold_price: number | null;
  reconciliation_status: string;
};
type Batch = { report_id: string; starts_on: string; ends_on: string; row_count: number };
type AppOnly = { lot_seq: number; example_sku: string; app_sold_on: string; app_sold_price: number | null; sales_channels: string };
type ReturnWorkRow = { lot_seq: number; sku: string; status: string; amazon_returned_on: string | null; returned_on: string | null };

const lotNumber = (sku: string | null) => {
  const match = sku?.match(/^([0-9]+[a-z]*)[-_]/i);
  return match?.[1]?.toUpperCase() ?? null;
};
function resaleGroups(rows: Row[]) {
  const byLot = new Map<string, Row[]>();
  for (const row of rows) {
    if (!['Shipped', 'Delivered', 'Shipped - Delivered to Buyer'].includes(row.order_status)) continue;
    const lot = lotNumber(row.canonical_sku ?? row.sku);
    if (lot === null) continue;
    const group = byLot.get(lot) ?? [];
    group.push(row);
    byLot.set(lot, group);
  }
  return [...byLot.entries()]
    .filter(([, group]) => new Set(group.map(row => row.order_id)).size > 1)
    .map(([lot, group]) => ({ lot, orders: group.sort((a, b) => a.ordered_at.localeCompare(b.ordered_at)) }))
    .sort((a, b) => b.lot.localeCompare(a.lot, undefined, { numeric: true }));
}

async function readHistory(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await getSupabase().from('v_amazon_order_reconciliation')
      .select('order_item_id,order_id,ordered_at,order_on,order_status,sku,canonical_sku,quantity,item_price,app_sold_on,app_sold_price,reconciliation_status')
      .order('ordered_at', { ascending: false }).order('order_item_id').range(from, from + 499);
    if (error) throw error;
    rows.push(...(data ?? []) as Row[]);
    if (!data || data.length < 500) return rows;
  }
}

export default function AmazonOrderHistory() {
  const [rows, setRows] = useState<Row[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [appOnly, setAppOnly] = useState<AppOnly[]>([]);
  const [lotItems, setLotItems] = useState<ReturnWorkRow[]>([]);
  const [status, setStatus] = useState('要確認');
  const [month, setMonth] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const [history, reports, unmatched] = await Promise.all([
        readHistory(),
        getSupabase().from('amazon_order_report_batches').select('report_id,starts_on,ends_on,row_count').order('starts_on'),
        getSupabase().from('v_amazon_unmatched_app_sales').select('lot_seq,example_sku,app_sold_on,app_sold_price,sales_channels').order('lot_seq', { ascending: false }),
      ]);
      if (reports.error) throw reports.error;
      if (unmatched.error) throw unmatched.error;
      const lots = resaleGroups(history).map(group => Number.parseInt(group.lot, 10));
      const itemRows: ReturnWorkRow[] = [];
      for (let start = 0; start < lots.length; start += 100) {
        const { data, error: workError } = await getSupabase().from('items')
          .select('lot_seq,sku,status,amazon_returned_on,returned_on')
          .in('lot_seq', lots.slice(start, start + 100));
        if (workError) throw workError;
        itemRows.push(...((data ?? []) as ReturnWorkRow[]));
      }
      setRows(history);
      setBatches((reports.data ?? []) as Batch[]);
      setAppOnly((unmatched.data ?? []) as AppOnly[]);
      setLotItems(itemRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Amazonの履歴を表示できませんでした。');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const eligible = rows.filter(row => ['Shipped', 'Delivered', 'Shipped - Delivered to Buyer'].includes(row.order_status));
  const resale = useMemo(() => {
    const actualLots = new Set(lotItems.map(item => lotNumber(item.sku)));
    return resaleGroups(rows).filter(group => actualLots.has(group.lot));
  }, [rows, lotItems]);
  const unmatchedBaseSales = appOnly;
  const returnsByLot = useMemo(() => {
    const result = new Map<string, ReturnWorkRow[]>();
    for (const row of lotItems) if (row.amazon_returned_on || row.returned_on) {
      const serial = lotNumber(row.sku);
      if (serial) result.set(serial, [...(result.get(serial) ?? []), row]);
    }
    return result;
  }, [lotItems]);
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const row of eligible) result[row.reconciliation_status] = (result[row.reconciliation_status] ?? 0) + 1;
    return result;
  }, [rows]);
  const filtered = rows.filter(row => {
    if (status === '要確認' && ['対象外', '一致', '日付差'].includes(row.reconciliation_status)) return false;
    if (status !== '要確認' && status && row.reconciliation_status !== status) return false;
    if (month && !row.order_on.startsWith(month)) return false;
    if (search && !(row.sku ?? '').toLowerCase().includes(search.toLowerCase()) && !(row.canonical_sku ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const first = batches[0]?.starts_on;
  const last = batches[batches.length - 1]?.ends_on;

  return <details className="card amazon-sales">
    <summary>Amazon販売履歴・照合</summary>
    <div className="toolbar" style={{ marginTop: 12 }}>
      <strong>取得済み注文 {rows.length.toLocaleString()}件</strong>
      <span>期間 {first ?? '—'} ～ {last ?? '—'}（{batches.length}レポート）</span>
      <button className="btn" onClick={() => void load()} disabled={loading}>再読込</button>
    </div>
    <p className="sub">Amazonの注文レポートを保存し、アプリのSKUと照合しています。古いSKU形式も変換します。この履歴画面では在庫の販売記録を変更しません。</p>
    <div className="toolbar">
      <span>出荷済 {eligible.length.toLocaleString()}件</span>
      {['商品未登録', '同一SKU複数注文', 'アプリ未販売', '価格相違', '金額未確定', '複数個', '日付差', '一致'].map(key => <span key={key}>{key} {counts[key] ?? 0}</span>)}
      <span>アプリのみ販売済 {unmatchedBaseSales.length}</span>
    </div>
    <div className="toolbar">
      <label className="field"><span>注文月</span><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
      <label className="field"><span>照合結果</span><select value={status} onChange={e => setStatus(e.target.value)}><option>要確認</option><option value="">すべて</option>{['商品未登録', '同一SKU複数注文', 'アプリ未販売', '価格相違', '金額未確定', '複数個', '日付差', '一致', '対象外'].map(key => <option key={key}>{key}</option>)}</select></label>
      <input type="search" aria-label="Amazon SKUを検索" placeholder="SKUを検索" value={search} onChange={e => setSearch(e.target.value)} />
      <span>{filtered.length.toLocaleString()}件</span>
    </div>
    {loading && <p>読み込み中…</p>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="scroll" style={{ maxHeight: 520 }}><table><thead><tr><th>Amazon注文日</th><th>SKU</th><th>Amazon価格</th><th>アプリ販売日</th><th>アプリ価格</th><th>照合結果</th></tr></thead><tbody>{filtered.map(row => <tr key={row.order_item_id}>
      <td>{row.order_on}</td><td className="sku" title={row.canonical_sku ?? undefined}>{row.sku ?? '—'}</td>
      <td className="num">{row.item_price === null ? '—' : yen(row.item_price)}</td>
      <td>{row.app_sold_on ?? '—'}</td><td className="num">{row.app_sold_price === null ? '—' : yen(row.app_sold_price)}</td>
      <td>{row.reconciliation_status}</td>
    </tr>)}</tbody></table></div>
    <details style={{ marginTop: 14 }}><summary>同じ商品番号の複数注文（{resale.length}商品）</summary>
      <p className="sub">SKUの末尾a・aaを含む商品番号ごとに分け、Amazon注文を日付順に表示します。</p>
      {resale.map(({ lot, orders }) => {
        const work = returnsByLot.get(lot) ?? [];
        const orderIds = [...new Set(orders.map(row => row.order_id))];
        return <details key={lot} style={{ marginTop: 10 }}><summary>{lot}：Amazon注文 {new Set(orders.map(row => row.order_id)).size}件／返品記録 {work.length}件</summary>
          {work.length > 0 && <p className="sub">返品記録：{work.map(row => `${row.sku}（${row.amazon_returned_on ?? row.returned_on}）`).join('、')}</p>}
          <div className="scroll"><table><thead><tr><th>注文順</th><th>Amazon注文日</th><th>注文番号</th><th>Amazon SKU</th><th>価格</th><th>SKU一致行の販売日</th></tr></thead><tbody>{orders.map(row => <tr key={row.order_item_id}>
            <td>{orderIds.indexOf(row.order_id) + 1}</td><td>{row.order_on}</td><td>{row.order_id}</td><td className="sku">{row.sku ?? '—'}</td>
            <td className="num">{row.item_price === null ? '—' : yen(row.item_price)}</td><td>{row.app_sold_on ?? '—'}</td>
          </tr>)}</tbody></table></div>
        </details>;
      })}
    </details>
    <details style={{ marginTop: 14 }}><summary>アプリに販売記録があり、Amazon注文を見つけられない商品（{unmatchedBaseSales.length}件）</summary>
      <p className="sub">FBA・自己発送の本体を、a・aaを含むSKU商品番号ごとに照合した確認候補です。</p>
      <div className="scroll" style={{ maxHeight: 360 }}><table><thead><tr><th>通番号</th><th>SKU</th><th>アプリ販売日</th><th>アプリ価格</th><th>販売経路</th></tr></thead><tbody>{unmatchedBaseSales.map(row => <tr key={row.lot_seq}>
        <td>{row.lot_seq}</td><td className="sku">{row.example_sku}</td><td>{row.app_sold_on}</td><td className="num">{yen(row.app_sold_price)}</td><td>{row.sales_channels}</td>
      </tr>)}</tbody></table></div>
    </details>
  </details>;
}
