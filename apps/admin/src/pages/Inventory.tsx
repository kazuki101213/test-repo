import { staffDisplayName, productModelText, deliveryStaffOptions } from '@bussan/shared';
import ColoredSelect from '../components/ColoredSelect';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CONDITIONS, MARKETPLACES, SALES_CHANNELS, STATUSES, jpDate, yen } from '@bussan/shared';
import type { PurchaseDraft, Staff } from '@bussan/shared';
import type { InventoryEdit, InventoryItem } from '../api';
import { deleteInventoryItem, dismissPurchaseDraft, fetchInventoryItem, fetchItems, fetchPurchaseDrafts, fetchStaff, updateInventoryField, updateInventoryItem } from '../api';
import type { InventoryField } from '../api';
import { downloadCsv } from '../csv';
import NewPurchase from './NewPurchase';
import AmazonSalesSync from '../components/AmazonSalesSync';
import ColoredLabel from '../components/ColoredLabel';
import AmazonOrderHistory from '../components/AmazonOrderHistory';
import { productSerial } from '../inventory';

function elapsedJstDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  const start = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(start)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  return Math.floor((Date.parse(`${today}T00:00:00+09:00`) - start) / 86400000);
}

function inventoryRowTone(item: InventoryItem): string {
  if (item.status === '販売済' || (item.status === 'Amazon返品' && item.product_sold_on)) return 'inventory-row-sold';
  if (item.status === 'Amazon返品') return 'inventory-row-amazon-return';
  if (item.status === '返品処理') return 'inventory-row-return-processing';
  if (item.status === '作業中') {
    const days = elapsedJstDays(item.purchased_at);
    return days !== null && days >= 7 ? 'inventory-row-working-overdue' : '';
  }
  if (item.status === '出品中') {
    const days = elapsedJstDays(item.purchased_at);
    if (days === null || days < 0) return '';
    if (days >= 30) return 'inventory-row-listed-30';
    if (days >= 15) return 'inventory-row-listed-15';
    return 'inventory-row-listed';
  }
  return '';
}

export default function Inventory({ me }: { me: Staff }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[] | null>(null);
  const [selectedDelivererIds, setSelectedDelivererIds] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');
  const [count, setCount] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseDrafts, setPurchaseDrafts] = useState<PurchaseDraft[]>([]);
  const [selectedPurchaseDraft, setSelectedPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dismissingDraft, setDismissingDraft] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<{ item: InventoryItem; field: InventoryField } | null>(null);
  const [fullEditFor, setFullEditFor] = useState<InventoryItem | null>(null);
  const [expandedComment, setExpandedComment] = useState<InventoryItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(80);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const inventoryTopScrollRef = useRef<HTMLDivElement>(null);
  const inventoryTableScrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (quiet = false) => {
    const current = ++request.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      if (purchasedFrom && purchasedTo && purchasedFrom > purchasedTo) throw new Error('仕入日の終了日は、開始日以降の日付を選んでください。');
      const delivererFilter = selectedDelivererIds ?? undefined;
      const result = await fetchItems({ statuses: selectedStatuses ?? undefined, delivererIds: delivererFilter, query: query || undefined, purchasedFrom, purchasedTo }, active.signal);
      if (current !== request.current) return;
      setItems(result.items); setCount(result.count);
    } catch (e) {
      if (current !== request.current) return;
      setItems([]); setCount(0);
      setError(e instanceof Error ? e.message : e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [selectedStatuses, selectedDelivererIds, query, purchasedFrom, purchasedTo]);

  useEffect(() => { void load(); return () => { request.current++; controller.current?.abort(); }; }, [load]);
  useEffect(() => {
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void load(true); };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);
  useEffect(() => { fetchStaff().then(setStaff).catch(() => undefined); }, []);
  const loadPurchaseDrafts = useCallback(() => {
    fetchPurchaseDrafts().then(rows => { setPurchaseDrafts(rows); setDraftError(null); }).catch(error => {
      setDraftError(error instanceof Error ? error.message : String(error));
    });
  }, []);
  useEffect(() => { loadPurchaseDrafts(); }, [loadPurchaseDrafts]);
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
  const trackingColumnWidth = items.reduce((width, item) => Math.max(width, Math.min(232, (Array.from(item.tracking_no ?? '').length) * 10 + 32)), 140);
  const inventoryTableWidth = Math.max(2710, 2350 + trackingColumnWidth);
  const syncInventoryScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (source && target && target.clientWidth > 0 && target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
  };
  const deliverers = deliveryStaffOptions(staff);
  const statusOptions = [...STATUSES.map(value => ({ value, label: value })), { value: 'marketplace:動作品Amazon返品', label: '動作品Amazon返品' }, { value: '__unsold__', label: '未販売のみ' }];
  const allStatusValues = statusOptions.filter(option => option.value !== '__unsold__').map(option => option.value);
  const unsoldOnly = selectedStatuses?.includes('__unsold__') ?? false;

  async function excludeDraft(id: string) {
    if (dismissingDraft) return;
    setDismissingDraft(id); setDraftError(null);
    try { await dismissPurchaseDraft(id); setPurchaseDrafts(rows => rows.filter(row => row.id !== id)); }
    catch (cause) { setDraftError(cause instanceof Error ? cause.message : cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)); }
    finally { setDismissingDraft(null); }
  }

  function toggleStatus(value: string, checked: boolean) {
    setSelectedStatuses(current => {
      const selected = current ?? [];
      const next = checked ? [...new Set([...selected, value])] : selected.filter(option => option !== value);
      return next;
    });
  }

  if (purchaseOpen) return <section className="purchase-registration-screen" aria-label="在庫登録">
    <button type="button" className="btn" onClick={() => { setPurchaseOpen(false); setSelectedPurchaseDraft(null); }}>在庫・仕入れリストへ戻る</button>
    {selectedPurchaseDraft && <p>仕入れリストから登録: {selectedPurchaseDraft.title}</p>}
    <NewPurchase key={selectedPurchaseDraft?.id ?? 'new'} me={me} draft={selectedPurchaseDraft} onSaved={() => { setSelectedPurchaseDraft(null); setPurchaseOpen(false); loadPurchaseDrafts(); void load(); }} />
  </section>;

  return (
    <div className={`inventory-workspace${purchaseOpen ? ' with-purchase' : ''}`}>
      <section className="inventory-list" aria-label="在庫">
      <h2>在庫</h2>




      <div className="toolbar">
        <input
          type="search" placeholder="SKU / 商品名 / ASIN / 型番 / 商品ID / 追跡番号" value={query}
          aria-label="在庫を検索" onChange={(e) => { setQuery(e.target.value); }} style={{ minWidth: 240 }}
        />
        <details className="inventory-filter-dropdown">
          <summary>状態（{selectedStatuses === null ? 'すべて' : `${selectedStatuses.filter(value => value !== '__unsold__').length}/${allStatusValues.length}${unsoldOnly ? '・未販売のみ' : ''}`}）</summary>
          <div className="inventory-filter-options">
            <label><input type="checkbox" checked={selectedStatuses === null} onChange={event => setSelectedStatuses(event.target.checked ? null : [])} />すべて</label>
            {statusOptions.map(option => <label key={option.value}>
            <input type="checkbox" checked={selectedStatuses?.includes(option.value) ?? false} onChange={event => toggleStatus(option.value, event.target.checked)} />
            {option.label}
          </label>)}</div>
        </details>
        <details className="inventory-filter-dropdown">
          <summary>納品担当者（{selectedDelivererIds === null ? '全員' : `${selectedDelivererIds.length}/${deliverers.length}`}）</summary>
          <div className="inventory-filter-options">
            <label><input type="checkbox" checked={selectedDelivererIds === null} onChange={event => setSelectedDelivererIds(event.target.checked ? null : [])} />全員</label>
            {deliverers.map(person => <label key={person.id}>
            <input type="checkbox" checked={selectedDelivererIds?.includes(person.id) ?? false} onChange={event => setSelectedDelivererIds(current => {
              const selected = current ?? [];
              const next = event.target.checked ? [...new Set([...selected, person.id])] : selected.filter(id => id !== person.id);
              return next;
            })} />
            {staffDisplayName(person)}
          </label>)}</div>
        </details>
        <div className="inventory-date-range" role="group" aria-label="仕入日の期間">
          <label className="inventory-date-field" data-empty={!purchasedFrom}>
            <input type="date" aria-label="仕入日・開始日" value={purchasedFrom} max={purchasedTo || undefined} onChange={e => setPurchasedFrom(e.target.value)} />
            {!purchasedFrom && <span className="inventory-date-placeholder" aria-hidden="true">仕入日</span>}
          </label>
          <span aria-hidden="true">〜</span>
          <label className="inventory-date-field" data-empty={!purchasedTo}>
            <input type="date" aria-label="仕入日・終了日" value={purchasedTo} min={purchasedFrom || undefined} onChange={e => setPurchasedTo(e.target.value)} />
            {!purchasedTo && <span className="inventory-date-placeholder" aria-hidden="true">仕入日</span>}
          </label>
        </div>
        {(purchasedFrom || purchasedTo) && <button className="btn" onClick={() => { setPurchasedFrom(''); setPurchasedTo(''); }}>期間を解除</button>}
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
      <details className="card purchase-draft-panel">
        <summary>仕入れリスト（未反映 {purchaseDrafts.length}件）</summary>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={loadPurchaseDrafts}>リストを更新</button>
          <span className="sub">フリマの購入・落札履歴から取得した下書きです。在庫へ反映する前に金額・担当者を確認してください。</span>
        </div>
        {draftError && <div className="error">仕入れリストを読み込めませんでした: {draftError}</div>}
        {purchaseDrafts.length > 0 ? <div className="scroll"><table className="purchase-draft-table"><thead><tr><th>購入日</th><th>商品情報</th><th>仕入先</th><th>購入金額</th><th>商品ID</th><th>販売予定金額</th><th>振込予定金額</th><th>操作</th></tr></thead><tbody>
          {purchaseDrafts.map(draft => <tr key={draft.id}><td>{draft.purchased_at || '要入力'}</td><td><a title={draft.title} href={draft.marketplace_url} target="_blank" rel="noreferrer">{Array.from(draft.title).slice(0, 20).join('')}</a><div className="purchase-draft-product-meta">型番 {draft.model_no || '未特定'} / 品番 {draft.product_no ?? '未特定'} / ASIN {draft.asin || '未特定'}</div></td><td><ColoredLabel value={draft.marketplace} /></td><td>{draft.cost_amount == null ? '要入力' : yen(draft.cost_amount)}</td><td>{draft.marketplace_item_id}</td><td>{draft.planned_price == null ? '未特定' : yen(draft.planned_price)}</td><td>{draft.planned_payout == null ? '未特定' : yen(draft.planned_payout)}</td><td><div className="purchase-draft-actions">
            <button type="button" className="btn primary" onClick={() => { setSelectedPurchaseDraft(draft); setPurchaseOpen(true); window.scrollTo({ top: 0 }); }}>在庫へ反映</button>
            <button type="button" className="btn" disabled={dismissingDraft !== null} onClick={() => void excludeDraft(draft.id)}>{dismissingDraft === draft.id ? '除外中…' : '除外'}</button>
          </div></td></tr>)}
        </tbody></table></div> : !draftError && <p className="sub">未反映の購入履歴はありません。</p>}
      </details>
      {me.role === 'admin' && <AmazonOrderHistory />}
      <div className="toolbar" aria-label="在庫の商品件数" aria-live="polite"><span>{loading ? '読み込み中…' : `${count.toLocaleString()}商品`}</span></div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {!loading && items.length > 0 && (
        <>
        <div className="inventory-top-scroll" aria-label="在庫を左右にスクロール" ref={inventoryTopScrollRef} onScroll={event => syncInventoryScroll(event.currentTarget, inventoryTableScrollRef.current)}>
          <div style={{ width: inventoryTableWidth, height: 1 }} />
        </div>
        <div className="scroll inventory-bottom-scroll" ref={inventoryTableScrollRef} onScroll={event => syncInventoryScroll(event.currentTarget, inventoryTopScrollRef.current)}>
          <table className="inventory-table" aria-rowcount={items.length + 1} style={{ minWidth: inventoryTableWidth, '--tracking-column-width': `${trackingColumnWidth}px` } as CSSProperties}>
            <thead>
              <tr aria-rowindex={1}>
                <th>Amazonの写真</th><th>通番号 / 品番<br />SKU</th><th>ASIN<br />型番</th>
                <th>仕入担当者<br />納品担当者</th><th>仕入先<br />商品ID/追跡番号</th>
                <th>仕入日<br />仕入金額</th><th>販売先<br />商品状態</th>
                <th>梱包日<br />出荷日</th><th>販売予定金額<br />振込予定金額</th>
                <th>見込利益額<br />予定利益率</th><th>販売日<br />販売日数</th>
                <th>販売金額<br />振込金額</th><th>利益額<br />利益率</th>
                <th>在庫の払い戻し<br />Amazon以外からの返金</th><th>Amazon返金金額</th><th>納品担当者からのコメント</th><th>販売状態</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, visibleCount).map((i, index) => {
                const serial = productSerial(i.sku, i.lot_seq);
                const previous = items[index - 1];
                const next = items[index + 1];
                const previousSerial = previous ? productSerial(previous.sku, previous.lot_seq) : null;
                const nextSerial = next ? productSerial(next.sku, next.lot_seq) : null;
                const sharedSaleItem = i.is_accessory && !i.product_sale_conflict ? { ...i, sold_on: i.product_sold_on, sold_price: i.product_sold_price, payout_amount: i.product_payout_amount } : i;
                const edit = (field: InventoryField) => setEditFor({ item: ['sold_on','sold_price','payout_amount','sales_channel'].includes(field) ? sharedSaleItem : i, field });
                const stacked = (top: ReactNode, topField: InventoryField, bottom?: ReactNode, bottomField?: InventoryField) => <div className="inventory-cell-stack"><button type="button" className="inventory-cell-edit" onClick={() => edit(topField)} title="クリックして編集">{top}</button>{bottom !== undefined && <button type="button" className="inventory-cell-edit" onClick={() => edit(bottomField ?? topField)} title="クリックして編集">{bottom}</button>}</div>;
                const expectedRate = i.planned_price && i.expected_profit !== null ? `${((i.expected_profit / i.planned_price) * 100).toFixed(1)}%` : '—';
                const rowTone = inventoryRowTone(i);
                const actualRate = i.product_sold_price && i.product_sold_price > 0 && i.product_profit !== null ? `${((i.product_profit / i.product_sold_price) * 100).toFixed(1)}%` : '—';
                const soldDays = i.product_sold_on && i.purchased_at
                  ? Math.round((Date.parse(`${i.product_sold_on}T00:00:00Z`) - Date.parse(`${i.purchased_at}T00:00:00Z`)) / 86400000)
                  : i.days_in_stock ?? i.days_to_sell;
                const modelOrAccessoryName = i.is_accessory ? i.title : productModelText(i);
                const modelOrAccessoryField: InventoryField = i.is_accessory || (!i.model_no && i.marketplace !== '動作品Amazon返品') ? 'title' : 'model_no';
                return (
                <tr key={i.id} className={rowTone} aria-rowindex={index + 2} data-lot={serial} data-group-end={serial !== nextSerial}>
                  <td><button type="button" className="inventory-photo" onClick={() => setFullEditFor(sharedSaleItem)} title="クリックして商品情報を編集" aria-label={`${i.sku}の商品情報を編集`}>
                    {i.amazon_image_url ? <img src={i.amazon_image_url} alt={`${i.title}のAmazon画像`} loading="lazy" /> : <span className="inventory-photo-empty">—</span>}
                  </button></td>
                  <td><div className="inventory-cell-stack"><div className="inventory-identity-line">
                    {(i.is_accessory || serial !== previousSerial) && <><button type="button" className="inventory-cell-edit" onClick={() => edit('lot_seq')}>{serial}</button><span> / </span></>}
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('product_no')}>{i.product_no ?? '—'}</button>
                  </div><button type="button" className="inventory-cell-edit sku" onClick={() => edit('sku')}>{i.sku}</button></div></td>
                  <td><div className="inventory-cell-stack">
                    <button type="button" className="inventory-cell-edit" onClick={() => edit('asin')}>{i.asin ?? '—'}</button>
                    <button type="button" className="inventory-cell-edit" onClick={() => edit(modelOrAccessoryField)} title={i.is_accessory ? i.title : 'クリックして編集'}>{modelOrAccessoryName}</button>
                  </div></td>
                  <td>{stacked(staffDisplayName(i.purchaser_name) || '—', 'purchaser_id', staffDisplayName(i.deliverer_name) || '—', 'deliverer_id')}</td>
                  <td><div className="inventory-cell-stack">
                    <button type="button" className="inventory-cell-edit inventory-marketplace-name" onClick={() => edit('marketplace')} title="仕入先を編集">{<ColoredLabel value={i.marketplace} />}</button>
                    <button type="button" className="inventory-cell-edit inventory-marketplace-item-id" onClick={() => edit('marketplace_item_id')} title="商品IDをクリックして編集">{i.marketplace_item_id || '—'}</button>
                    <button type="button" className="inventory-cell-edit inventory-tracking-number" onClick={() => edit('tracking_no')} title="追跡番号をクリックして編集">{Array.from(i.tracking_no ?? '').slice(0, 20).join('') || '—'}</button>
                  </div></td>
                  <td>{stacked(jpDate(i.purchased_at), 'purchased_at', yen(i.cost_amount), 'cost_amount')}</td>
                  <td>{stacked(<ColoredLabel value={i.sales_channel ?? '—'} />, 'sales_channel', <ColoredLabel value={i.condition ?? '—'} />, 'condition')}</td>
                  <td>{stacked(jpDate(i.packed_on), 'packed_on', jpDate(i.shipped_on), 'shipped_on')}</td>
                  <td>{stacked(yen(i.planned_price), 'planned_price', yen(i.planned_payout), 'planned_payout')}</td>
                  <td>{stacked(yen(i.expected_profit), 'planned_payout', expectedRate, 'planned_price')}</td>
                  <td>{stacked(i.product_sale_conflict ? '要確認' : jpDate(i.product_sold_on), 'sold_on', soldDays == null ? '—' : `${soldDays}日`, 'sold_on')}</td>
                  <td>{stacked(yen(i.product_sale_conflict ? i.sold_price : i.product_sold_price), 'sold_price', yen(i.product_sale_conflict ? i.payout_amount : i.product_payout_amount), 'payout_amount')}</td>
                  <td>{stacked(yen(i.product_profit), 'payout_amount', actualRate, 'sold_price')}</td>
                  <td>{stacked(yen(i.inventory_refund_amount), 'inventory_refund_amount', yen(i.non_amazon_refund_amount), 'non_amazon_refund_amount')}</td>
                  <td><button type="button" className="inventory-cell-edit" onClick={() => edit('amazon_refund_amount')} title="Amazon返金金額をクリックして編集">{yen(i.amazon_refund_amount)}</button></td>
                  <td>{i.latest_comment ? (() => { const chars = Array.from(i.latest_comment); return <button type="button" className="inventory-comment" onClick={() => setExpandedComment(i)} title="コメント全文を表示"><span>{chars.slice(0, 10).join('')}</span><span>{chars.slice(10, 20).join('')}{chars.length > 20 ? '…' : ''}</span></button>; })() : '—'}</td>
                  <td><div className="inventory-cell-stack inventory-sale-status"><span>{i.status || '—'}</span><span className="muted">{i.is_accessory ? '付属品' : '本体'}</span></div></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
        </>
      )}
      {visibleCount < items.length && <div ref={loadMoreRef} className="toolbar"><button className="btn" onClick={() => setVisibleCount(current => Math.min(current + 80, items.length))}>さらに表示</button></div>}
      </section>


      {editFor && <InventoryFieldDialog key={`${editFor.item.id}:${editFor.field}`} item={editFor.item} field={editFor.field} staff={staff} onClose={() => setEditFor(null)} onSaved={() => { setEditFor(null); void load(); }} />}
      {fullEditFor && <InventoryFullEditDialog key={fullEditFor.id} item={fullEditFor} staff={staff} canDelete={me.role === 'admin'} onClose={() => setFullEditFor(null)} onSaved={() => { setFullEditFor(null); void load(); }} />}
      {expandedComment && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="コメント全文"><div className="card inventory-comment-panel"><h3>{expandedComment.sku} のコメント</h3><p>{expandedComment.latest_comment}</p><button className="btn" onClick={() => setExpandedComment(null)}>閉じる</button></div></div>}
    </div>
  );
}

const fullEditFields: (keyof InventoryEdit)[] = [
  'is_accessory','title','asin','tracking_no','purchased_at','cost_amount','planned_price','planned_payout',
  'packed_on','shipped_on','status','memo','purchaser_id','deliverer_id','marketplace',
  'condition','sales_channel','sold_on','sold_price','payout_amount','refund_amount','inventory_refund_amount',
  'amazon_refund_amount','non_amazon_refund_amount','marketplace_item_id',
];

function InventoryFullEditDialog({ item, staff, canDelete, onClose, onSaved }: { item: InventoryItem; staff: Staff[]; canDelete: boolean; onClose: () => void; onSaved: () => void }) {
  const [identity, setIdentity] = useState({ sku: item.sku, lot_seq: item.lot_seq, model_no: item.model_no, product_no: item.product_no });
  const [values, setValues] = useState<InventoryEdit>(() => ({
    is_accessory: item.is_accessory, title: item.title, asin: item.asin, tracking_no: item.tracking_no, purchased_at: item.purchased_at,
    cost_amount: item.cost_amount, planned_price: item.planned_price, planned_payout: item.planned_payout,
    packed_on: item.packed_on, shipped_on: item.shipped_on, status: item.status, memo: item.memo,
    purchaser_id: item.purchaser_id, deliverer_id: item.deliverer_id, marketplace: item.marketplace,
    condition: item.condition, sales_channel: item.sales_channel, sold_on: item.sold_on,
    sold_price: item.sold_price, payout_amount: item.payout_amount, refund_amount: item.refund_amount,
    amazon_refund_amount: item.amazon_refund_amount, non_amazon_refund_amount: item.non_amazon_refund_amount,
    inventory_refund_amount: item.inventory_refund_amount,
    marketplace_item_id: item.marketplace_item_id,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dateFields = new Set<keyof InventoryEdit>(['purchased_at','packed_on','shipped_on','sold_on']);
  const numberFields = new Set<keyof InventoryEdit>(['cost_amount','planned_price','planned_payout','sold_price','payout_amount','refund_amount','inventory_refund_amount','amazon_refund_amount','non_amazon_refund_amount']);
  function optionsFor(field: keyof InventoryEdit) {
    if (field === 'is_accessory') return [{ value: 'false', label: '本体' }, { value: 'true', label: '付属品' }];
    if (field === 'status') return STATUSES.map(value => ({ value, label: value }));
    if (field === 'marketplace') return MARKETPLACES.map(value => ({ value, label: value }));
    if (field === 'sales_channel') return SALES_CHANNELS.map(value => ({ value, label: value }));
    if (field === 'condition') return CONDITIONS.map(value => ({ value, label: value }));
    if (field === 'purchaser_id') return staff.filter(person => person.role !== 'deliverer').map(person => ({ value: person.id, label: staffDisplayName(person) }));
    if (field === 'deliverer_id') return deliveryStaffOptions(staff).map(person => ({ value: person.id, label: staffDisplayName(person) }));
    return null;
  }
  function set(field: keyof InventoryEdit, text: string) {
    const value = field === 'is_accessory' ? text === 'true' : text === '' ? null : numberFields.has(field) ? Number(text) : text;
    setValues(current => ({ ...current, [field]: value }) as InventoryEdit);
  }
  async function save() {
    setBusy(true); setError('');
    try {
      let current = item;
      if (identity.lot_seq !== item.lot_seq) {
        await updateInventoryField(current, 'lot_seq', String(identity.lot_seq));
        current = await fetchInventoryItem(item.id);
      }
      if (identity.sku !== item.sku) {
        await updateInventoryField(current, 'sku', identity.sku);
        current = await fetchInventoryItem(item.id);
      }
      await updateInventoryItem(current, values);
      if (identity.product_no !== item.product_no) await updateInventoryField(current, 'product_no', String(identity.product_no ?? ''));
      if (identity.model_no !== item.model_no) await updateInventoryField(current, 'model_no', String(identity.model_no ?? ''));
      onSaved();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  async function remove() {
    const confirmed = window.confirm(`「${item.sku}」を在庫から削除しますか？削除した商品情報は元に戻せません。`);
    if (!confirmed) return;
    setBusy(true); setError('');
    try { await deleteInventoryItem(item); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '削除できませんでした。'); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="商品情報を編集">
    <div className="card inventory-full-edit-panel"><h3>商品情報を編集</h3><p className="sku">{item.sku}</p>
      <div className="grid cols2">
        <label className="field"><span>通番号</span><input type="number" min={1} step={1} value={identity.lot_seq} onChange={event => setIdentity(current => ({ ...current, lot_seq: Number(event.target.value) }))} /></label>
        <label className="field"><span>SKU</span><input value={identity.sku} onChange={event => setIdentity(current => ({ ...current, sku: event.target.value }))} /></label>
        <label className="field"><span>品番</span><input type="number" min={1} step={1} value={identity.product_no ?? ''} onChange={event => setIdentity(current => ({ ...current, product_no: event.target.value ? Number(event.target.value) : null }))} /></label>
        <label className="field"><span>型番</span><input value={identity.model_no ?? ''} onChange={event => setIdentity(current => ({ ...current, model_no: event.target.value || null }))} /></label>
        {fullEditFields.map(field => {
        const options = optionsFor(field), current = values[field] ?? '';
        return <label className="field" key={field}><span>{fieldLabels[field]}</span>
          {options ? <ColoredSelect value={String(current)} onChange={event => set(field, event.target.value)}><option value="">未設定</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</ColoredSelect>
            : field === 'memo' ? <textarea value={String(current)} onChange={event => set(field, event.target.value)} />
            : <input type={dateFields.has(field) ? 'date' : numberFields.has(field) ? 'number' : 'text'} min={numberFields.has(field) && field !== 'amazon_refund_amount' ? 0 : undefined} step={numberFields.has(field) ? 1 : undefined} value={String(current)} onChange={event => set(field, event.target.value)} />}
        </label>;
      })}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>{canDelete && <button className="btn" disabled={busy} onClick={() => void remove()} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>削除</button>}<button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}

const fieldLabels: Record<InventoryField, string> = {
  is_accessory: '登録区分',
  title: '商品名', asin: 'ASIN', tracking_no: '追跡番号', purchased_at: '仕入日',
  cost_amount: '仕入金額', planned_price: '販売予定金額', planned_payout: '振込予定金額',
  packed_on: '梱包日', shipped_on: '出荷日', status: '作業状態', memo: 'メモ',
  purchaser_id: '仕入担当者', deliverer_id: '納品担当者', marketplace: '仕入先',
  condition: '商品状態', sales_channel: '販売先', sold_on: '販売日',
  sold_price: '販売金額', payout_amount: '振込金額', amazon_refund_amount: 'Amazon返金金額',
  non_amazon_refund_amount: 'Amazon以外からの返金', product_no: '品番', model_no: '型番',
  lot_seq: '通番号', sku: 'SKU', marketplace_item_id: '商品ID', refund_amount: '返金合計', inventory_refund_amount: '在庫の払い戻し',
};

function InventoryFieldDialog({ item, field, staff, onClose, onSaved }: { item: InventoryItem; field: InventoryField; staff: Staff[]; onClose: () => void; onSaved: () => void }) {
  const initial = item[field] ?? '';
  const [value, setValue] = useState(String(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dateFields = new Set<InventoryField>(['purchased_at', 'packed_on', 'shipped_on', 'sold_on']);
  const numberFields = new Set<InventoryField>(['lot_seq', 'product_no', 'cost_amount', 'planned_price', 'planned_payout', 'sold_price', 'payout_amount', 'refund_amount', 'inventory_refund_amount', 'amazon_refund_amount', 'non_amazon_refund_amount']);
  const options = field === 'status' ? STATUSES.map(v => ({ value: v, label: v }))
    : field === 'is_accessory' ? [{ value: 'false', label: '本体' }, { value: 'true', label: '付属品' }]
    : field === 'marketplace' ? MARKETPLACES.map(v => ({ value: v, label: v }))
    : field === 'sales_channel' ? SALES_CHANNELS.map(v => ({ value: v, label: v }))
    : field === 'condition' ? CONDITIONS.map(v => ({ value: v, label: v }))
    : field === 'purchaser_id' ? staff.filter(s => s.role !== 'deliverer').map(s => ({ value: s.id, label: staffDisplayName(s) }))
    : field === 'deliverer_id' ? deliveryStaffOptions(staff).map(s => ({ value: s.id, label: staffDisplayName(s) })) : null;
  async function save() {
    setBusy(true); setError('');
    try { await updateInventoryField(item, field, value); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存できませんでした。'); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label={`${fieldLabels[field]}を編集`}>
    <div className="card inventory-comment-panel">
      <h3>{fieldLabels[field]}を編集</h3><p className="sku">{item.lot_seq} / {item.sku}</p>
      <label className="field"><span>{fieldLabels[field]}</span>
        {options ? <ColoredSelect value={value} onChange={e => setValue(e.target.value)}>{!['status', 'marketplace'].includes(field) && <option value="">未設定</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</ColoredSelect>
          : field === 'memo' ? <textarea value={value} onChange={e => setValue(e.target.value)} />
            : <input autoFocus type={dateFields.has(field) ? 'date' : numberFields.has(field) ? 'number' : 'text'} min={field === 'lot_seq' || field === 'product_no' ? '1' : numberFields.has(field) && field !== 'amazon_refund_amount' ? '0' : undefined} step={numberFields.has(field) ? '1' : undefined} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />}
      </label>
      {field === 'is_accessory' && value === 'true' && !item.is_accessory && <p className="muted">付属品に変更すると、販売金額と振込金額は自動で空欄になります。</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
