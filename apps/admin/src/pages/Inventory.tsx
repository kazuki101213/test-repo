import {usePurchaseSync} from '../hooks/usePurchaseSync';
import { staffDisplayName, productModelText, deliveryStaffOptions, HELD_STATUSES } from '@bussan/shared';
import {useInventoryPage} from '../hooks/useInventoryPage';
import { usePurchaseDrafts } from '../hooks/usePurchaseDrafts';
import ColoredSelect from '../components/ColoredSelect';
import DateInput from '../components/DateInput';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CONDITIONS, MARKETPLACES, SALES_CHANNELS, STATUSES, jpDate, yen, matchesInventoryFilters } from '@bussan/shared';
import type { PurchaseDraft, Staff, InventoryFilters } from '@bussan/shared';
import type { InventoryEdit, InventoryItem } from '../api';
import { deleteInventoryItem, dismissPurchaseDraft, fetchCards, fetchInventoryItem, fetchInventoryPaymentCard, fetchPurchaseDrafts, fetchStaff, updateInventoryField, updateInventoryItem } from '../api';
import type { InventoryField } from '../api';
import NewPurchase from './NewPurchase';
import AmazonSalesSync from '../components/AmazonSalesSync';
import ColoredLabel from '../components/ColoredLabel';
import AmazonOrderHistory from '../components/AmazonOrderHistory';
import { productCount, productSerial } from '../inventory';
import { filterInventoryColumns, inventoryColumns, isColumnFilterActive, salePrice, salePayout, saleDays, type ColumnFilters } from '../inventoryFilters';
import InventoryStateFilter from '../components/InventoryStateFilter';
import InventoryColumnFilter from '../components/InventoryColumnFilter';
import { inventorySearchFields, type InventorySearchField } from '../inventorySearch';

function inventoryError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object') {
    const error = cause as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [error.message, error.details, error.hint].filter((part): part is string => typeof part === 'string' && !!part);
    if (parts.length) return parts.join(' ');
  }
  return '保存できませんでした。';
}

function elapsedJstDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  const start = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(start)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  return Math.floor((Date.parse(`${today}T00:00:00+09:00`) - start) / 86400000);
}

function inventoryRowTone(item: InventoryItem): string {
  if (item.status === '販売済') return 'inventory-row-sold';
  if (item.status === '返品処理') return 'inventory-row-return-processing';
  if (HELD_STATUSES.includes(item.status)) {
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

  const [staff, setStaff] = useState<Staff[]>([]);
  const [queryField, setQueryField] = useState<InventorySearchField>('serial');
  const [query, setQuery] = useState('');
  const [inventoryFilters, setInventoryFilters] = useState<InventoryFilters>({});
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});
  const [openColumn, setOpenColumn] = useState<{ field: string; anchor: HTMLElement } | null>(null);
  const closeColumn = useCallback(() => setOpenColumn(null), []);
  const activeColumnCount=Object.values(columnFilters).filter(isColumnFilterActive).length;
  const inventory=useInventoryPage<InventoryItem>('management',me.id,{queryField,query,from:purchasedFrom,to:purchasedTo,states:inventoryFilters},!!openColumn||activeColumnCount>0);
  const items=inventory.rows,count=inventory.total,loading=inventory.loading;
  const viewItems=useMemo(()=>filterInventoryColumns(items.filter(item=>matchesInventoryFilters(item,inventoryFilters)),columnFilters),[items,columnFilters,inventoryFilters]);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const purchasePanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!purchaseOpen) return;
    const panel = purchasePanel.current;
    if (!panel) return;
    let frame = 0;
    const fit = () => {
      panel.style.setProperty('--purchase-panel-top', `${Math.ceil(Math.max(16, panel.getBoundingClientRect().top))}px`);
    };
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('scroll', scheduleFit, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('scroll', scheduleFit);
    };
  }, [purchaseOpen]);
  const { rows: purchaseDrafts, setRows: setPurchaseDrafts, loading: draftsLoading, error: draftError, setError: setDraftError, updated: draftsUpdated, refresh: loadPurchaseDrafts } = usePurchaseDrafts(fetchPurchaseDrafts);
  const purchaseSync = usePurchaseSync(loadPurchaseDrafts, me.role === 'admin');
  const [selectedPurchaseDraft, setSelectedPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [dismissingDraft, setDismissingDraft] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<{ item: InventoryItem; field: InventoryField } | null>(null);
  const [fullEditFor, setFullEditFor] = useState<InventoryItem | null>(null);
  const [expandedComment, setExpandedComment] = useState<{ sku: string; label: string; text: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(80);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const inventoryTopScrollRef = useRef<HTMLDivElement>(null);
  const inventoryTableScrollRef = useRef<HTMLDivElement>(null);

  const load=async()=>{await inventory.refresh();};
  useEffect(() => { fetchStaff().then(setStaff).catch(() => undefined); }, []);
  useEffect(() => { setVisibleCount(80); }, [queryField, query, purchasedFrom, purchasedTo, inventoryFilters, columnFilters]);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || visibleCount >= viewItems.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setVisibleCount(current => Math.min(current + 80, viewItems.length));
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewItems.length, visibleCount]);
  const trackingColumnWidth = items.reduce((width, item) => Math.max(width, Math.min(232, (Array.from(item.tracking_no ?? '').length) * 10 + 32)), 140);
  const inventoryTableWidth = Math.max(2890, 2530 + trackingColumnWidth);
  const syncInventoryScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (source && target && target.clientWidth > 0 && target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
  };

  async function excludeDraft(id: string) {
    if (dismissingDraft) return;
    setDismissingDraft(id); setDraftError(null);
    try { await dismissPurchaseDraft(id); setPurchaseDrafts(rows => rows.filter(row => row.id !== id)); }
    catch (cause) { setDraftError(cause instanceof Error ? cause.message : cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)); }
    finally { setDismissingDraft(null); }
  }

  function clearFilters() {
    setInventoryFilters({}); setColumnFilters({}); setOpenColumn(null); setQueryField('serial');
    setQuery(''); setPurchasedFrom(''); setPurchasedTo('');
  }
  const filterHeading = (field: string) => <button type="button" className={`inventory-column-heading${isColumnFilterActive(columnFilters[field]) ? ' active' : ''}`}
    aria-label={`${inventoryColumns[field]!.label}のフィルター`} aria-expanded={openColumn?.field === field}
    onClick={event => { const anchor = event.currentTarget; setOpenColumn(current => current?.field === field ? null : { field, anchor }); }}>
    {inventoryColumns[field]!.label}<span aria-hidden="true">{isColumnFilterActive(columnFilters[field]) ? ' ▾✓' : ' ▾'}</span>
  </button>;



  return (
    <div className={`inventory-workspace${purchaseOpen ? ' with-purchase' : ''}`}>
      <section className="inventory-list" aria-label="在庫">





      <div className="inventory-controls">
      <div className="inventory-registration-actions">
        <button className="btn primary" aria-expanded={purchaseOpen} aria-controls="inventory-purchase-panel" onClick={() => { if (purchaseOpen) setSelectedPurchaseDraft(null); setPurchaseOpen(open => !open); }}>
          在庫登録
        </button>
        {me.role === 'admin' && <AmazonSalesSync onApplied={() => void load()} />}
      </div>
      <div className="toolbar inventory-toolbar">
        <div className="inventory-search" role="group" aria-label="在庫検索">
          <select aria-label="検索項目" value={queryField} onChange={event => { setQueryField(event.target.value as InventorySearchField); setQuery(''); }}>
            {inventorySearchFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
          </select>
          <input type="search" placeholder="検索" value={query} aria-label="在庫を検索" onChange={event => setQuery(event.target.value)} />
        </div>
        <InventoryStateFilter value={inventoryFilters} onChange={setInventoryFilters} />
        <div className="inventory-date-range" role="group" aria-label="仕入日の期間">
          <label className="inventory-date-field">
            <DateInput aria-label="仕入日・開始日" placeholder="YY-MM-DD" value={purchasedFrom} max={purchasedTo || undefined} onChange={e => setPurchasedFrom(e.target.value)} />
          </label>
          <span aria-hidden="true">〜</span>
          <label className="inventory-date-field">
            <DateInput aria-label="仕入日・終了日" placeholder="YY-MM-DD" value={purchasedTo} min={purchasedFrom || undefined} onChange={e => setPurchasedTo(e.target.value)} />
          </label>
        </div>
        {(purchasedFrom || purchasedTo) && <button className="btn inventory-clear-dates" onClick={() => { setPurchasedFrom(''); setPurchasedTo(''); }}>期間を解除</button>}
        <button type="button" className="btn inventory-clear-filters" onClick={clearFilters}>フィルター解除</button>
        {activeColumnCount > 0 && <span className="sub">項目フィルター {activeColumnCount}件</span>}

      </div>
      </div>

      {purchaseOpen && <section ref={purchasePanel} id="inventory-purchase-panel" className="card inventory-purchase-panel registration-sidebar" aria-label="在庫登録" style={{ minWidth: 0 }}>
        <NewPurchase key={selectedPurchaseDraft?.id ?? 'new'} me={me} draft={selectedPurchaseDraft} onSaved={() => { setSelectedPurchaseDraft(null); setPurchaseOpen(false); loadPurchaseDrafts(); void load(); }} />
      </section>}

      <div className="inventory-data">
      <details className="card purchase-draft-panel">
        <summary>仕入れリスト（未反映 {purchaseDrafts.length}件）</summary>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={draftsLoading || purchaseSync.syncing || me.role !== 'admin'} onClick={() => void purchaseSync.startSync()}>{purchaseSync.syncing ? '同期中…' : '更新'}</button>
          <span className="sub" role="status" aria-live="polite">{purchaseSync.message || (draftsLoading ? '仕入れリストを読み込んでいます…' : draftsUpdated ? `${draftsUpdated.at} 更新しました（未反映 ${draftsUpdated.count}件）` : '')}</span>
        </div>
        {purchaseSync.error && <div className="error">{purchaseSync.error}</div>}
        {draftError && <div className="error">仕入れリストを読み込めませんでした: {draftError}</div>}
        {purchaseDrafts.length > 0 ? <div className="scroll"><table className="purchase-draft-table"><thead><tr><th>購入日</th><th>商品情報</th><th>仕入先</th><th>購入金額</th><th>商品ID</th><th>販売予定金額</th><th>振込予定金額</th><th>操作</th></tr></thead><tbody>
          {purchaseDrafts.map(draft => <tr key={draft.id}><td>{draft.purchased_at || '要入力'}</td><td><a title={draft.title} href={draft.marketplace_url} target="_blank" rel="noreferrer">{Array.from(draft.title).slice(0, 20).join('')}</a><div className="purchase-draft-product-meta">型番 {draft.model_no || '未特定'} / 品番 {draft.product_no ?? '未特定'} / ASIN {draft.asin || '未特定'}</div></td><td><ColoredLabel value={draft.marketplace} /></td><td>{draft.cost_amount == null ? '要入力' : yen(draft.cost_amount)}</td><td>{draft.marketplace_item_id}</td><td>{draft.planned_price == null ? '未特定' : yen(draft.planned_price)}</td><td>{draft.planned_payout == null ? '未特定' : yen(draft.planned_payout)}</td><td><div className="purchase-draft-actions">
            <button type="button" className="btn primary" onClick={() => { setSelectedPurchaseDraft(draft); setPurchaseOpen(true); window.scrollTo({ top: 0 }); }}>在庫へ反映</button>
            <button type="button" className="btn" disabled={dismissingDraft !== null} onClick={() => void excludeDraft(draft.id)}>{dismissingDraft === draft.id ? '除外中…' : '除外'}</button>
          </div></td></tr>)}
        </tbody></table></div> : !draftError && !draftsLoading && <p className="sub">未反映の購入履歴はありません。</p>}
      </details>
      {me.role === 'admin' && <AmazonOrderHistory />}
      <div className="toolbar" aria-label="在庫の商品件数" aria-live="polite"><span>{loading ? (items.length ? `${(activeColumnCount ? productCount(viewItems) : count).toLocaleString()}商品を表示・残りを読み込み中…` : '読み込み中…') : `${(activeColumnCount ? productCount(viewItems) : count).toLocaleString()}商品`}</span></div>

      {inventory.error&&<div className="error">{inventory.error}</div>}
      {loading && items.length === 0 && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {items.length > 0 && (
        <>
        <div className="inventory-top-scroll" aria-label="在庫を左右にスクロール" ref={inventoryTopScrollRef} onScroll={event => syncInventoryScroll(event.currentTarget, inventoryTableScrollRef.current)}>
          <div style={{ width: inventoryTableWidth, height: 1 }} />
        </div>
        <div className="scroll inventory-bottom-scroll" ref={inventoryTableScrollRef} onScroll={event => syncInventoryScroll(event.currentTarget, inventoryTopScrollRef.current)}>
          <table className="inventory-table" aria-rowcount={viewItems.length + 1} style={{ minWidth: inventoryTableWidth, '--tracking-column-width': `${trackingColumnWidth}px` } as CSSProperties}>
            <thead>
              <tr aria-rowindex={1}>
                <th>{filterHeading('photo')}</th><th>{filterHeading('serial')} / {filterHeading('product_no')}<br />{filterHeading('sku')}</th><th>{filterHeading('asin')}<br />{filterHeading('model')}</th>
                <th>{filterHeading('purchaser')}<br />{filterHeading('deliverer')}</th><th>{filterHeading('marketplace')}<br />{filterHeading('item_id')} / {filterHeading('tracking')}</th>
                <th>{filterHeading('purchased_at')}<br />{filterHeading('cost')}</th><th>{filterHeading('sales_channel')}<br />{filterHeading('condition')}</th>
                <th>{filterHeading('packed_on')}<br />{filterHeading('shipped_on')}</th><th>{filterHeading('planned_price')}<br />{filterHeading('planned_payout')}</th>
                <th>{filterHeading('expected_profit')}<br />{filterHeading('expected_rate')}</th><th>{filterHeading('sold_on')}<br />{filterHeading('sold_days')}</th>
                <th>{filterHeading('sold_price')}<br />{filterHeading('payout')}</th><th>{filterHeading('profit')}<br />{filterHeading('rate')}</th>
                <th>{filterHeading('inventory_refund')}<br />{filterHeading('other_refund')}</th><th>{filterHeading('amazon_refund')}</th><th>{filterHeading('purchaser_comment')}</th><th>{filterHeading('comment')}</th><th>{filterHeading('status')}<br />{filterHeading('registration')}</th>
              </tr>
            </thead>
            <tbody>
              {viewItems.slice(0, visibleCount).map((i, index) => {
                const serial = productSerial(i.sku, i.lot_seq);
                const previous = viewItems[index - 1];
                const next = viewItems[index + 1];
                const previousSerial = previous ? productSerial(previous.sku, previous.lot_seq) : null;
                const nextSerial = next ? productSerial(next.sku, next.lot_seq) : null;
                const attachedAccessory = i.is_accessory && !/^[0-9]+c+$/i.test(productSerial(i.sku, i.lot_seq)) && !i.product_sale_conflict;
                const sharedSaleItem = attachedAccessory ? { ...i, sold_on: i.product_sold_on } : i;
                const edit = (field: InventoryField) => setEditFor({ item: ['sold_on','sold_price','payout_amount','sales_channel'].includes(field) ? sharedSaleItem : i, field });
                const stacked = (top: ReactNode, topField: InventoryField, bottom?: ReactNode, bottomField?: InventoryField) => <div className="inventory-cell-stack"><button type="button" className="inventory-cell-edit" onClick={() => edit(topField)} title="クリックして編集">{top}</button>{bottom !== undefined && <button type="button" className="inventory-cell-edit" onClick={() => edit(bottomField ?? topField)} title="クリックして編集">{bottom}</button>}</div>;
                const expectedRate = i.planned_price && i.expected_profit !== null ? `${((i.expected_profit / i.planned_price) * 100).toFixed(1)}%` : '—';
                const rowTone = inventoryRowTone(i);
                const actualRate = i.product_sold_price && i.product_sold_price > 0 && i.product_profit !== null ? `${((i.product_profit / i.product_sold_price) * 100).toFixed(1)}%` : '—';

                const soldDays = saleDays(i);
                const modelOrAccessoryName = i.is_accessory ? i.title : productModelText(i);
                const modelOrAccessoryField: InventoryField = i.is_accessory || (!i.model_no && i.marketplace !== '動作品Amazon返品') ? 'title' : 'model_no';
                return (
                <tr key={i.id} className={rowTone} aria-rowindex={index + 2} data-lot={serial} data-group-end={serial !== nextSerial}>
                  <td><button type="button" className="inventory-photo" onClick={() => setFullEditFor(sharedSaleItem)} title="商品情報編集" aria-label={`${i.sku}の商品情報編集`}>
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
                  <td>{stacked(i.product_sale_conflict ? '要確認' : jpDate(i.product_sold_on), 'sold_on', i.status==='返品処理' ? undefined : soldDays == null ? '—' : `${soldDays}日`, 'sold_on')}</td>
                  <td>{attachedAccessory ? <div className="inventory-cell-stack"><span>—</span><span>—</span></div> : stacked(yen(salePrice(i)), 'sold_price', yen(salePayout(i)), 'payout_amount')}</td>
                  <td>{attachedAccessory ? <div className="inventory-cell-stack"><span>—</span><span>—</span></div> : stacked(yen(i.product_profit), 'payout_amount', actualRate, 'sold_price')}</td>
                  <td>{stacked(yen(i.inventory_refund_amount), 'inventory_refund_amount', yen(i.non_amazon_refund_amount), 'non_amazon_refund_amount')}</td>
                  <td><button type="button" className="inventory-cell-edit" onClick={() => edit('amazon_refund_amount')} title="Amazon返金金額をクリックして編集">{yen(i.amazon_refund_amount)}</button></td>
                  <td><button type="button" className="inventory-comment" onClick={() => edit('memo')} title="仕入担当者からのコメントを編集" aria-label={`${i.sku}の仕入担当者からのコメントを編集`}><span>{Array.from(i.memo ?? '').slice(0, 10).join('') || '—'}</span><span>{Array.from(i.memo ?? '').slice(10, 20).join('')}{Array.from(i.memo ?? '').length > 20 ? '…' : ''}</span></button></td>
                  <td>{i.latest_comment ? (() => { const chars = Array.from(i.latest_comment); return <button type="button" className="inventory-comment" onClick={() => setExpandedComment({ sku: i.sku, label: '納品担当者からのコメント', text: i.latest_comment! })} title="コメント全文を表示"><span>{chars.slice(0, 10).join('')}</span><span>{chars.slice(10, 20).join('')}{chars.length > 20 ? '…' : ''}</span></button>; })() : '—'}</td>
                  <td><div className="inventory-cell-stack inventory-sale-status"><span>{i.status || '—'}</span><span className="muted">{i.is_accessory ? '付属品' : '本体'}</span></div></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
        </>
      )}
      {!loading && items.length > 0 && viewItems.length === 0 && <p className="empty" role="status">フィルターに一致する在庫はありません。フィルターの条件を変更するか、すべて解除してください。</p>}
      {(visibleCount<viewItems.length||inventory.more)&&<div ref={loadMoreRef} className="toolbar"><button className="btn" disabled={loading} onClick={()=>{if(visibleCount<viewItems.length)setVisibleCount(current=>Math.min(current+80,viewItems.length));else {setVisibleCount(current=>current+50);inventory.loadMore();}}}>さらに表示</button></div>}
      </div>
      </section>
      {openColumn && <InventoryColumnFilter key={openColumn.field} field={openColumn.field} anchor={openColumn.anchor} items={items} current={columnFilters[openColumn.field]} onClose={closeColumn} onApply={filter => {
        setColumnFilters(current => { const next = { ...current }; if (filter && isColumnFilterActive(filter)) next[openColumn.field] = filter; else delete next[openColumn.field]; return next; });
        setOpenColumn(null);
      }} />}


      {editFor && <InventoryFieldDialog key={`${editFor.item.id}:${editFor.field}`} item={editFor.item} field={editFor.field} staff={staff} onClose={() => setEditFor(null)} onSaved={() => { setEditFor(null); void load(); }} />}
      {fullEditFor && <InventoryFullEditDialog key={fullEditFor.id} item={fullEditFor} staff={staff} canDelete={me.role === 'admin'} onClose={() => setFullEditFor(null)} onSaved={() => { setFullEditFor(null); void load(); }} />}
      {expandedComment && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="コメント全文"><div className="card inventory-comment-panel"><h3>{expandedComment.sku} {expandedComment.label}</h3><p>{expandedComment.text}</p><button className="btn" onClick={() => setExpandedComment(null)}>閉じる</button></div></div>}
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
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [cardId, setCardId] = useState('');
  const [paymentReady, setPaymentReady] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCards(), fetchInventoryPaymentCard(item.id)]).then(([options, currentId]) => {
      if (cancelled) return;
      // Keep an inactive payment method visible until the user explicitly changes it.
      setCards(currentId && !options.some(option => option.id === currentId)
        ? [...options, { id: currentId, name: item.card_name ?? '現在の支払い方法' }] : options);
      setCardId(currentId ?? '');
      setPaymentReady(true);
    }).catch(cause => { if (!cancelled) setPaymentError(inventoryError(cause)); });
    return () => { cancelled = true; };
  }, [item.id, item.card_name]);
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
    if (!paymentReady) return;
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
      await updateInventoryItem(current, { ...values, card_id: cardId || null });
      if (identity.product_no !== item.product_no) await updateInventoryField(current, 'product_no', String(identity.product_no ?? ''));
      if (identity.model_no !== item.model_no) await updateInventoryField(current, 'model_no', String(identity.model_no ?? ''));
      onSaved();
    }
    catch (cause) { setError(inventoryError(cause)); setBusy(false); }
  }
  async function remove() {
    const confirmed = window.confirm(`「${item.sku}」を在庫から削除しますか？削除した商品情報は元に戻せません。`);
    if (!confirmed) return;
    setBusy(true); setError('');
    try { await deleteInventoryItem(item); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '削除できませんでした。'); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="商品情報編集">
    <div className="card inventory-full-edit-panel"><h3>商品情報編集</h3><p className="sku">{item.sku}</p>
      <div className="grid cols2">
        <label className="field"><span>通番号</span><input type="number" min={1} step={1} value={identity.lot_seq} onChange={event => setIdentity(current => ({ ...current, lot_seq: Number(event.target.value) }))} /></label>
        <label className="field"><span>SKU</span><input type="text" value={identity.sku} onChange={event => setIdentity(current => ({ ...current, sku: event.target.value }))} /></label>
        <label className="field"><span>品番</span><input type="number" min={1} step={1} value={identity.product_no ?? ''} onChange={event => setIdentity(current => ({ ...current, product_no: event.target.value ? Number(event.target.value) : null }))} /></label>
        <label className="field"><span>型番</span><input type="text" value={identity.model_no ?? ''} onChange={event => setIdentity(current => ({ ...current, model_no: event.target.value || null }))} /></label>
        <label className="field"><span>支払い方法</span><select value={cardId} disabled={!paymentReady || busy} onChange={event => setCardId(event.target.value)}>
          <option value="">{paymentReady ? '未設定' : '読み込み中…'}</option>
          {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
        </select></label>
        {fullEditFields.map(field => {
        const options = optionsFor(field), current = values[field] ?? '';
        return <label className="field" key={field}><span>{fieldLabels[field]}</span>
          {options ? <ColoredSelect value={String(current)} onChange={event => set(field, event.target.value)}><option value="">未設定</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</ColoredSelect>
            : field === 'memo' ? <textarea value={String(current)} onChange={event => set(field, event.target.value)} />
            : dateFields.has(field)
              ? <DateInput value={String(current)} onChange={event => set(field, event.target.value)} />
              : <input type={numberFields.has(field) ? 'number' : 'text'} min={numberFields.has(field) && field !== 'amazon_refund_amount' ? 0 : undefined} step={numberFields.has(field) ? 1 : undefined} value={String(current)} onChange={event => set(field, event.target.value)} />}
        </label>;
      })}</div>
      {error && <div className="error" role="alert">{error}</div>}
      {paymentError && <div className="error" role="alert">支払い方法を読み込めませんでした。画面を開き直してください。{paymentError}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy || !paymentReady} onClick={() => void save()}>保存</button>{canDelete && <button className="btn" disabled={busy} onClick={() => void remove()} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>削除</button>}<button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}

const fieldLabels: Record<InventoryField, string> = {
  is_accessory: '登録区分',
  title: '商品名', asin: 'ASIN', tracking_no: '追跡番号', purchased_at: '仕入日',
  cost_amount: '仕入金額', planned_price: '販売予定金額', planned_payout: '振込予定金額',
  packed_on: '作業完了日', shipped_on: '出荷日', status: '作業状態', memo: '仕入担当者からのコメント',
  purchaser_id: '仕入担当者', deliverer_id: '納品担当者', marketplace: '仕入先',
  condition: '商品状態', sales_channel: '販売先', sold_on: '販売日',
  sold_price: '販売金額', payout_amount: '振込金額', amazon_refund_amount: 'Amazon返金金額',
  non_amazon_refund_amount: 'Amazon以外からの補填', product_no: '品番', model_no: '型番',
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
    catch (cause) { setError(inventoryError(cause)); setBusy(false); }
  }
  return <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label={`${fieldLabels[field]}を編集`}>
    <div className="card inventory-comment-panel">
      <h3>{fieldLabels[field]}を編集</h3><p className="sku">{item.lot_seq} / {item.sku}</p>
      <label className="field"><span>{fieldLabels[field]}</span>
        {options ? <ColoredSelect value={value} onChange={e => setValue(e.target.value)}>{!['status', 'marketplace'].includes(field) && <option value="">未設定</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</ColoredSelect>
          : field === 'memo' ? <textarea value={value} onChange={e => setValue(e.target.value)} />
            : dateFields.has(field)
              ? <DateInput autoFocus value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />
              : <input autoFocus type={numberFields.has(field) ? 'number' : 'text'} min={field === 'lot_seq' || field === 'product_no' ? '1' : numberFields.has(field) && field !== 'amazon_refund_amount' ? '0' : undefined} step={numberFields.has(field) ? '1' : undefined} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} />}
      </label>
      {field === 'is_accessory' && value === 'true' && !item.is_accessory && <p className="muted">付属品に変更すると、販売金額と振込金額は自動で空欄になります。</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
