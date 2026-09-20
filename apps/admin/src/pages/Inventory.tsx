import { useCallback, useEffect, useState } from 'react';
import { STATUSES, STATUS_COLORS, jpDate, yen, errorMessage } from '@bussan/shared';
import type { ItemView, Staff } from '@bussan/shared';
import { fetchAmazonFeed, fetchItems, fetchStaff, recordSale } from '../api';
import { downloadCsv, downloadTsv } from '../csv';

export default function Inventory() {
  const [items, setItems] = useState<ItemView[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [status, setStatus] = useState('');
  const [delivererId, setDelivererId] = useState('');
  const [query, setQuery] = useState('');
  const [unsoldOnly, setUnsoldOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saleFor, setSaleFor] = useState<ItemView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchItems({ status: status || undefined, delivererId: delivererId || undefined, query: query || undefined, unsoldOnly }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [status, delivererId, query, unsoldOnly]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { fetchStaff().then(setStaff).catch(() => undefined); }, []);

  async function exportAmazon() {
    try {
      const rows = await fetchAmazonFeed();
      const cleaned = rows.map(({ item_id: _i, status: _s, deliverer_id: _d, ...rest }) => rest);
      if (cleaned.length === 0) { setError('出品対象（写真登録まで完了した商品）がありません。'); return; }
      downloadTsv(`amazon-listing-${new Date().toISOString().slice(0, 10)}.txt`, cleaned);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <h2>在庫一覧</h2>
      <p className="sub">納品管理表の各担当者シートをひとつにまとめたものです。</p>

      <div className="toolbar">
        <input
          type="search" placeholder="SKU / 商品名 / ASIN / 型番" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 240 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">すべての状態</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={delivererId} onChange={(e) => setDelivererId(e.target.value)}>
          <option value="">すべての納品担当者</option>
          {staff.filter((s) => s.role === 'deliverer').map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <label className="row" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={unsoldOnly} onChange={(e) => setUnsoldOnly(e.target.checked)} />
          未販売のみ
        </label>
        <button className="btn" onClick={() => void load()}>再読込</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, items as unknown as Record<string, unknown>[])}>
          CSV
        </button>
        <button className="btn" onClick={() => void exportAmazon()}>Amazon出品ファイル</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {items.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>状態</th><th>商品名</th><th>ASIN</th>
                <th>仕入日</th><th className="num">仕入</th>
                <th>仕入先</th><th>納品担当</th><th>進捗</th>
                <th className="num">予定価格</th><th className="num">見込利益</th>
                <th className="num">在庫日数</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="sku">{i.sku}</td>
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
                  <td className="num">{i.days_in_stock ?? '—'}</td>
                  <td>
                    {i.sold_on === null && (
                      <button className="btn" onClick={() => setSaleFor(i)}>販売登録</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {saleFor && (
        <SaleDialog
          item={saleFor}
          onClose={() => setSaleFor(null)}
          onSaved={() => { setSaleFor(null); void load(); }}
        />
      )}
    </>
  );
}

function SaleDialog({ item, onClose, onSaved }: { item: ItemView; onClose: () => void; onSaved: () => void }) {
  const [soldOn, setSoldOn] = useState(new Date().toISOString().slice(0, 10));
  const [price, setPrice] = useState(item.planned_price ?? 0);
  const [payout, setPayout] = useState(item.planned_payout ?? 0);
  const [shipping, setShipping] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await recordSale(item.id, {
        sold_on: soldOn, sold_price: price, payout_amount: payout, shipping_cost: shipping,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const profit = payout - item.cost_amount - shipping;

  return (
    <div className="card" style={{ position: 'fixed', inset: 'auto 24px 24px auto', width: 340, zIndex: 20, boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}>
      <h3>販売登録</h3>
      <p className="sku">{item.sku}</p>
      <p className="sub" style={{ margin: '0 0 10px' }}>{item.title}</p>

      <label className="field"><span>販売日</span>
        <input type="date" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 8 }}><span>販売価格</span>
        <input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      </label>
      <label className="field" style={{ marginTop: 8 }}><span>振込額（手数料控除後）</span>
        <input type="number" value={payout} onChange={(e) => setPayout(Number(e.target.value))} />
      </label>
      <label className="field" style={{ marginTop: 8 }}><span>送料など</span>
        <input type="number" value={shipping} onChange={(e) => setShipping(Number(e.target.value))} />
      </label>

      <p style={{ marginTop: 10 }}>
        粗利 <strong style={{ color: profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{yen(profit)}</strong>
        <span className="sub"> （仕入 {yen(item.cost_amount)}）</span>
      </p>

      {error && <div className="error">{error}</div>}
      <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
