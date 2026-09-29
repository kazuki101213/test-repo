import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CONDITIONS, MARKETPLACES, SALES_CHANNELS, STATUSES, STATUS_COLORS, jpDate, yen } from '@bussan/shared';
import type { Staff } from '@bussan/shared';
import type { InventoryItem } from '../api';
import { fetchItems, fetchStaff, updateInventoryField } from '../api';
import type { InventoryField } from '../api';
import { downloadCsv } from '../csv';
import NewPurchase from './NewPurchase';
import AmazonSalesSync from '../components/AmazonSalesSync';
import AmazonOrderHistory from '../components/AmazonOrderHistory';
import { purchaseItemUrl } from '../purchaseUrl';

export default function Inventory({ me }: { me: Staff }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [status, setStatus] = useState('');
  const [delivererId, setDelivererId] = useState('');
  const [query, setQuery] = useState('');
  const [unsoldOnly, setUnsoldOnly] = useState(false);
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');
  const [count, setCount] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [editFor, setEditFor] = useState<{ item: InventoryItem; field: InventoryField } | null>(null);
  const [expandedComment, setExpandedComment] = useState<InventoryItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(80);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const current = ++request.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError(null);
    try {
      if (purchasedFrom && purchasedTo && purchasedFrom > purchasedTo) throw new Error('仕入日の終了日は、開始日以降の日付を選んでください。');
      const result = await fetchItems({ status: status || undefined, delivererId: delivererId || undefined, query: query || undefined, unsoldOnly, purchasedFrom, purchasedTo }, active.signal);
      if (current !== request.current) return;
      setItems(result.items); setCount(result.count);
    } catch (e) {
      if (current !== request.current) return;
      setItems([]); setCount(0);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [status, delivererId, query, unsoldOnly, purchasedFrom, purchasedTo]);

  useEffect(() => { void load(); return () => { request.current++; controller.current?.abort(); }; }, [load]);
  useEffect(() => { fetchStaff().then(setStaff).catch(() => undefined); }, []);
  useEffect(() => { setVisibleCount(80); }, [items]);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || visibleCount >= items.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setVisibleCount(current => Math.min(current + 80, items.length));
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, visibleCount]);

  return (
    <div className={`inventory-workspace${purchaseOpen ? ' with-purchase' : ''}`}>
      <section className="inventory-list" aria-label="在庫一覧">
      <h2>在庫一覧</h2>


      <div className="toolbar">
        <input
          type="search" placeholder="SKU / 商品名 / ASIN / 型番" value={query}
          aria-label="在庫を検索" onChange={(e) => { setQuery(e.target.value); }} style={{ minWidth: 240 }}
        />
        <select aria-label="状態" value={status} onChange={(e) => { setStatus(e.target.value); }}>
          <option value="">すべての状態</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="納品担当者" value={delivererId} onChange={(e) => { setDelivererId(e.target.value); }}>
          <option value="">すべての納品担当者</option>
          {staff.filter((s) => s.role === 'deliverer').map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <label className="field"><span>仕入日・開始</span>
          <input type="date" value={purchasedFrom} max={purchasedTo || undefined} onChange={e => setPurchasedFrom(e.target.value)} />
        </label>
        <label className="field"><span>仕入日・終了</span>
          <input type="date" value={purchasedTo} min={purchasedFrom || undefined} onChange={e => setPurchasedTo(e.target.value)} />
        </label>
        {(purchasedFrom || purchasedTo) && <button className="btn" onClick={() => { setPurchasedFrom(''); setPurchasedTo(''); }}>期間を解除</button>}
        <label className="row" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={unsoldOnly} onChange={(e) => { setUnsoldOnly(e.target.checked); }} />
          未販売のみ
        </label>
        <button className="btn" onClick={() => void load()}>再読込</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, items as unknown as Record<string, unknown>[])}>
          一覧をCSV
        </button>
        <button className="btn" aria-expanded={purchaseOpen} aria-controls="inventory-purchase-panel" onClick={() => setPurchaseOpen(open => !open)}>
          {purchaseOpen ? '在庫登録を閉じる' : '在庫登録'}
        </button>
      </div>

      {me.role === 'admin' && <AmazonSalesSync onApplied={() => void load()} />}
      {me.role === 'admin' && <AmazonOrderHistory />}
      <div className="toolbar" aria-label="在庫の商品件数" aria-live="polite">
        <span>{loading ? '読み込み中…' : `${count.toLocaleString()}商品（通番号の重複を除く）・全件表示`} {unsoldOnly ? '（未販売のみ）' : '（販売済みを含む）'}</span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {!loading && items.length > 0 && (
        <div className="scroll">
          <table className="inventory-table" aria-rowcount={items.length + 1}>
            <thead>
              <tr aria-rowindex={1}>
                <th>作業状態</th><th>通番号 / 品番<br />SKU</th><th>ASIN<br />商品名 / 型番</th>
                <th>仕入担当者<br />納品担当者</th><th>Amazonの写真</th><th>仕入先<br />商品ID</th>
                <th>仕入日<br />仕入金額</th><th>販売先<br />商品状態</th>
                <th>梱包日<br />出荷日</th><th>販売予定金額<br />振込予定金額</th>
                <th>見込利益額<br />予定利益率</th><th>販売日<br />販売日数</th>
                <th>販売金額<br />振込金額</th><th>利益額<br />利益率</th>
                <th>Amazon返金金額<br />Amazon以外からの返金</th><th>コメント</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, visibleCount).map((i, index) => {
                const edit = (field: InventoryField) => setEditFor({ item: i, field });
                const stacked = (top: ReactNode, topField: InventoryField, bottom?: ReactNode, bottomField?: InventoryField) => <div className="inventory-cell-stack"><button type="button" className="inventory-cell-edit" onClick={() => edit(topField)} title="クリックして編集">{top}</button>{bottom !== undefined && <button type="button" className="inventory-cell-edit" onClick={() => edit(bottomField ?? topField)} title="クリックして編集">{bottom}</button>}</div>;
                const expectedRate = i.planned_price && i.expected_profit !== null ? `${((i.expected_profit / i.planned_price) * 100).toFixed(1)}%` : '—';
                const actualRate = i.product_sold_price && i.product_sold_price > 0 && i.product_profit !== null ? `${((i.product_profit / i.product_sold_price) * 100).toFixed(1)}%` : '—';
                return (
                <tr key={i.id} aria-rowindex={index + 2} data-lot={i.lot_seq} data-group-end={i.lot_seq !== items[index + 1]?.lot_seq}>
                  <td>{stacked(<><span className="dot" style={{ background: STATUS_COLORS[i.status] }} />{i.status}</>, 'status')}</td>
                  <td><div className="inventory-cell-stack"><div className="inventory-identity-line">
                    {i.lot_seq !== items[index - 1]?.lot_seq && <><button type="button" className="inventory-cell-edit" onClick={() => edit('lot_seq')}>{i.lot_seq}</button><span> / </span></>}
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('product_no')}>{i.product_no ?? '—'}</button>
                  </div><button type="button" className="inventory-cell-edit sku" onClick={() => edit('sku')}>{i.sku}</button></div></td>
                  <td><div className="inventory-cell-stack">
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('asin')}>{i.asin ?? '—'}</button>
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('title')}>{i.is_accessory && <span className="badge">付属</span>}{i.title}</button>
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('model_no')}>型番 {i.model_no ?? '—'}</button>
                  </div></td>
                  <td>{stacked(i.purchaser_name ?? '—', 'purchaser_id', i.deliverer_name ?? '—', 'deliverer_id')}</td>
                  <td>{i.amazon_image_url ? <a className="inventory-photo" href={i.amazon_image_url} target="_blank" rel="noreferrer"><img src={i.amazon_image_url} alt={`${i.title}のAmazon画像`} loading="lazy" /></a> : <span className="inventory-photo-empty">—</span>}</td>
                  <td><div className="inventory-cell-stack">
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('marketplace')} title="仕入先を編集">{i.marketplace}</button>
                    {i.marketplace_item_id ? (() => {
                      const url = purchaseItemUrl(i.marketplace, i.marketplace_item_id, i.marketplace_url);
                      return url ? <a href={url} target="_blank" rel="noopener noreferrer">{i.marketplace_item_id}</a> : <span>{i.marketplace_item_id}</span>;
                    })() : <span>—</span>}
                  </div></td>
                  <td>{stacked(jpDate(i.purchased_at), 'purchased_at', yen(i.cost_amount), 'cost_amount')}</td>
                  <td>{stacked(i.sales_channel ?? '—', 'sales_channel', i.condition ?? '—', 'condition')}</td>
                  <td>{stacked(jpDate(i.packed_on), 'packed_on', jpDate(i.shipped_on), 'shipped_on')}</td>
                  <td>{stacked(yen(i.planned_price), 'planned_price', yen(i.planned_payout), 'planned_payout')}</td>
                  <td>{stacked(yen(i.expected_profit), 'planned_payout', expectedRate, 'planned_price')}</td>
                  <td>{stacked(i.product_sale_conflict ? '要確認' : jpDate(i.product_sold_on), 'sold_on', (i.days_in_stock ?? i.days_to_sell) == null ? '—' : `${i.days_in_stock ?? i.days_to_sell}日`, 'sold_on')}</td>
                  <td>{stacked(yen(i.product_sale_conflict ? i.sold_price : i.product_sold_price), 'sold_price', yen(i.product_sale_conflict ? i.payout_amount : i.product_payout_amount), 'payout_amount')}</td>
                  <td>{stacked(yen(i.product_profit), 'payout_amount', actualRate, 'sold_price')}</td>
                  <td>{stacked(yen(i.amazon_refund_amount), 'amazon_refund_amount', yen(i.non_amazon_refund_amount), 'non_amazon_refund_amount')}</td>
                  <td>{i.latest_comment ? <button type="button" className="inventory-comment" onClick={() => setExpandedComment(i)} title="コメント全文を表示">{i.latest_comment.slice(0, 20)}{i.latest_comment.length > 20 ? '…' : ''}</button> : '—'}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}
      {visibleCount < items.length && <div ref={loadMoreRef} className="toolbar"><button className="btn" onClick={() => setVisibleCount(current => Math.min(current + 80, items.length))}>さらに表示</button></div>}
      </section>
      {purchaseOpen && <aside id="inventory-purchase-panel" className="purchase-panel" aria-label="在庫登録">
        <NewPurchase me={me} onSaved={() => void load()} />
      </aside>}

      {editFor && <InventoryFieldDialog key={`${editFor.item.id}:${editFor.field}`} item={editFor.item} field={editFor.field} staff={staff} onClose={() => setEditFor(null)} onSaved={() => { setEditFor(null); void load(); }} />}
      {expandedComment && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="コメント全文"><div className="card inventory-comment-panel"><h3>{expandedComment.sku} のコメント</h3><p>{expandedComment.latest_comment}</p><button className="btn" onClick={() => setExpandedComment(null)}>閉じる</button></div></div>}
    </div>
  );
}

const fieldLabels: Record<InventoryField, string> = {
  title: '商品名', asin: 'ASIN', tracking_no: '追跡番号', purchased_at: '仕入日',
  cost_amount: '仕入金額', planned_price: '販売予定金額', planned_payout: '振込予定金額',
  packed_on: '梱包日', shipped_on: '出荷日', status: '作業状態', memo: 'メモ',
  purchaser_id: '仕入担当者', deliverer_id: '納品担当者', marketplace: '仕入先',
  condition: '商品状態', sales_channel: '販売先', sold_on: '販売日',
  sold_price: '販売金額', payout_amount: '振込金額', amazon_refund_amount: 'Amazon返金金額',
  non_amazon_refund_amount: 'Amazon以外からの返金', product_no: '品番', model_no: '型番',
  lot_seq: '通番号', sku: 'SKU',
};

function InventoryFieldDialog({ item, field, staff, onClose, onSaved }: { item: InventoryItem; field: InventoryField; staff: Staff[]; onClose: () => void; onSaved: () => void }) {
  const initial = item[field] ?? '';
  const [value, setValue] = useState(String(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dateFields = new Set<InventoryField>(['purchased_at', 'packed_on', 'shipped_on', 'sold_on']);
  const numberFields = new Set<InventoryField>(['lot_seq', 'product_no', 'cost_amount', 'planned_price', 'planned_payout', 'sold_price', 'payout_amount', 'amazon_refund_amount', 'non_amazon_refund_amount']);
  const options = field === 'status' ? STATUSES.map(v => ({ value: v, label: v }))
    : field === 'marketplace' ? MARKETPLACES.map(v => ({ value: v, label: v }))
    : field === 'sales_channel' ? SALES_CHANNELS.map(v => ({ value: v, label: v }))
    : field === 'condition' ? CONDITIONS.map(v => ({ value: v, label: v }))
    : field === 'purchaser_id' ? staff.filter(s => s.role !== 'deliverer').map(s => ({ value: s.id, label: s.name }))
    : field === 'deliverer_id' ? staff.map(s => ({ value: s.id, label: s.name })) : null;
  async function save() {
    setBusy(true); setError('');
    try { await updateInventoryField(item, field, value); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存できませんでした。'); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label={`${fieldLabels[field]}を編集`}>
    <div className="card inventory-comment-panel">
      <h3>{fieldLabels[field]}を編集</h3><p className="sku">{item.lot_seq} / {item.sku}</p>
      <label className="field"><span>{fieldLabels[field]}</span>
        {options ? <select value={value} onChange={e => setValue(e.target.value)}>{!['status', 'marketplace'].includes(field) && <option value="">未設定</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : field === 'memo' ? <textarea value={value} onChange={e => setValue(e.target.value)} />
            : <input autoFocus type={dateFields.has(field) ? 'date' : numberFields.has(field) ? 'number' : 'text'} min={field === 'lot_seq' || field === 'product_no' ? '1' : numberFields.has(field) ? '0' : undefined} step={numberFields.has(field) ? '1' : undefined} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />}
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
