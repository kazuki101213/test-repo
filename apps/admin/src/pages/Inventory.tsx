import { useCallback, useEffect, useRef, useState } from 'react';
import { STATUSES, STATUS_COLORS, jpDate, yen } from '@bussan/shared';
import type { Staff } from '@bussan/shared';
import type { InventoryItem } from '../api';
import { fetchItems, fetchStaff, recordSale } from '../api';
import { downloadCsv } from '../csv';
import NewPurchase from './NewPurchase';
import AmazonSalesSync from '../components/AmazonSalesSync';
import { inventoryWindow } from '../inventory';

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
  const [saleFor, setSaleFor] = useState<InventoryItem | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(1000);
  const window = inventoryWindow(items.length, scrollTop, viewportHeight);

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
  useEffect(() => {
    setScrollTop(0);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [items, loading]);

  return (
    <div className="inventory-workspace with-purchase">
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
      </div>

      {me.role === 'admin' && <AmazonSalesSync onApplied={() => void load()} />}
      <div className="toolbar" aria-label="在庫の商品件数" aria-live="polite">
        <span>{loading ? '読み込み中…' : `${count.toLocaleString()}商品（通番号の重複を除く）・全件表示`} {unsoldOnly ? '（未販売のみ）' : '（販売済みを含む）'}</span>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {!loading && items.length > 0 && (
        <div className="scroll" ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
          <table className="inventory-table" aria-rowcount={items.length + 1}>
            <thead>
              <tr aria-rowindex={1}>
                <th>通番号 / SKU</th><th>状態</th><th>商品名</th><th>ASIN</th>
                <th>仕入日</th><th className="num">仕入</th>
                <th>仕入先</th><th>納品担当</th><th>進捗</th>
                <th className="num">予定価格</th><th className="num">見込利益</th>
                <th>販売日</th><th className="num">販売価格</th><th className="num">振込額（手数料控除後）</th>
                <th className="num">在庫日数</th><th></th>
              </tr>
            </thead>
            <tbody>
              {window.top > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={16} style={{ height: window.top }} /></tr>}
              {items.slice(window.start, window.end).map((i, offset) => {
                const index = window.start + offset;
                return (
                <tr key={i.id} aria-rowindex={index + 2} data-lot={i.lot_seq} data-group-end={i.lot_seq !== items[index + 1]?.lot_seq}>
                  <td>{i.lot_seq !== items[index - 1]?.lot_seq && <strong>{i.lot_seq}</strong>}<div className="sku">{i.sku}</div>{i.lot_seq !== items[index - 1]?.lot_seq && i.product_row_count > 1 && <small className="sub">仕入合計 {yen(i.product_cost)}</small>}</td>
                  <td>
                    <span className="dot" style={{ background: STATUS_COLORS[i.status] }} />
                    {i.status}
                  </td>
                  <td title={i.title} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {i.is_accessory && <span className="badge" style={{ marginRight: 4 }}>付属</span>}
                    {i.title}
                  </td>
                  <td>{i.asin ?? '—'}</td>
                  <td>{jpDate(i.purchased_at)}</td>
                  <td className="num">{yen(i.cost_amount)}</td>
                  <td>{i.marketplace}</td>
                  <td>{i.deliverer_name ?? '—'}</td>
                  <td>
                    {[i.product_registered, i.inspected, i.photo_uploaded, i.shipped_on !== null]
                      .map((d, n) => <span key={n} style={{ color: d ? 'var(--ok)' : 'var(--border)' }}>●</span>)}
                  </td>
                  <td className="num">{yen(i.planned_price)}</td>
                  <td className="num">{yen(i.expected_profit)}</td>
                  <td>{i.product_sale_conflict ? <span className="badge">販売記録の確認が必要</span> : jpDate(i.product_sold_on)}</td>
                  <td className="num">{yen(i.product_sale_conflict ? i.sold_price : i.product_sold_price)}</td>
                  <td className="num">{yen(i.product_sale_conflict ? i.payout_amount : i.product_payout_amount)}</td>
                  <td className="num">{i.days_in_stock ?? '—'}</td>
                  <td>
                    {i.sale_row_count === 0 && (
                      <button className="btn" onClick={() => setSaleFor(i)}>販売登録</button>
                    )}
                  </td>
                </tr>
              ); })}
              {window.bottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={16} style={{ height: window.bottom }} /></tr>}
            </tbody>
          </table>
        </div>
      )}
      </section>
      <aside className="purchase-panel" aria-label="仕入登録パネル">
        <NewPurchase me={me} onSaved={() => void load()} />
      </aside>

      {saleFor && (
        <SaleDialog
          item={saleFor}
          onClose={() => setSaleFor(null)}
          onSaved={() => { setSaleFor(null); void load(); }}
        />
      )}
    </div>
  );
}

function SaleDialog({ item, onClose, onSaved }: { item: InventoryItem; onClose: () => void; onSaved: () => void }) {
  const [soldOn, setSoldOn] = useState(new Date().toISOString().slice(0, 10));
  const [price, setPrice] = useState(item.planned_price ?? 0);
  const [payout, setPayout] = useState(item.planned_payout ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!soldOn || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(payout) || payout < 0) throw new Error('販売日と0円以上の整数の金額を入力してください。');
      await recordSale(item.id, {
        sold_on: soldOn, sold_price: price, payout_amount: payout,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const profit = payout - item.product_cost;

  return (
    <div className="card" style={{ position: 'fixed', inset: 'auto 24px 24px auto', width: 340, zIndex: 20, boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}>
      <h3>販売登録</h3>
      <p className="sku">{item.sku}</p>
      <p className="sub" style={{ margin: '0 0 10px' }}>{item.title}</p>
      <p className="sub">通番号 {item.lot_seq} の{item.product_row_count}行を同じ商品として、売上は1回だけ登録します。</p>

      <label className="field"><span>販売日</span>
        <input type="date" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 8 }}><span>販売価格</span>
        <input type="number" min={0} step={1} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      </label>
      <label className="field" style={{ marginTop: 8 }}><span>振込額（手数料控除後）</span>
        <input type="number" min={0} step={1} value={payout} onChange={(e) => setPayout(Number(e.target.value))} />
      </label>

      <p style={{ marginTop: 10 }}>
        振込額 − 仕入額 <strong style={{ color: profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{yen(profit)}</strong>
        <span className="sub"> （同一商品の仕入合計 {yen(item.product_cost)}）</span>
      </p>

      {error && <div className="error">{error}</div>}
      <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
