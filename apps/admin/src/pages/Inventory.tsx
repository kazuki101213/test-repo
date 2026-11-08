import { salesChannelLabel } from '@bussan/shared';
import InventoryOverview from '../components/InventoryOverview';
import {usePurchaseSync} from '../hooks/usePurchaseSync';
import { staffDisplayName, deliveryStaffOptions, inventorySiteStyle } from '@bussan/shared';
import {useInventoryPage} from '../hooks/useInventoryPage';
import { usePurchaseDrafts } from '../hooks/usePurchaseDrafts';
import ColoredSelect from '../components/ColoredSelect';
import DateInput from '../components/DateInput';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONDITIONS, MARKETPLACES, SALES_CHANNELS, STATUSES, yen, matchesInventoryFilters } from '@bussan/shared';
import type { PurchaseDraft, Staff, InventoryFilters } from '@bussan/shared';
import type { InventoryEdit, InventoryItem } from '../api';
import { deleteInventoryItem, dismissPurchaseDraft, fetchCards, fetchInventoryItem, fetchInventoryPaymentCard, fetchPurchaseDrafts, fetchStaff, updateInventoryField, updateInventoryItem } from '../api';
import type { InventoryField } from '../api';
import NewPurchase from './NewPurchase';
import AmazonSalesSync from '../components/AmazonSalesSync';
import AmazonOrderHistory from '../components/AmazonOrderHistory';
import { productCount, productSerial } from '../inventory';
import { filterInventoryColumns, inventoryColumns, isColumnFilterActive, type ColumnFilters } from '../inventoryFilters';
import InventoryStateFilter from '../components/InventoryStateFilter';
import InventoryColumnFilter from '../components/InventoryColumnFilter';
import { fetchAccessoryUsage, reassignAccessoryUsage, type AccessoryUsageContext } from '@bussan/shared';
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

export default function Inventory({ me }: { me: Staff }) {

  const [staff, setStaff] = useState<Staff[]>([]);
  const [queryField, setQueryField] = useState<InventorySearchField>('serial');
  const [query, setQuery] = useState('');
  const [inventoryFilters, setInventoryFilters] = useState<InventoryFilters>({});
  const [assigneeFilterIds, setAssigneeFilterIds] = useState<string[]>([]);
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});
  const [openColumn, setOpenColumn] = useState<{ field: string; anchor: HTMLElement } | null>(null);
  const closeColumn = useCallback(() => setOpenColumn(null), []);
  const activeColumnCount=Object.values(columnFilters).filter(isColumnFilterActive).length;
  const inventory=useInventoryPage<InventoryItem>('management',me.id,{queryField,query,from:purchasedFrom,to:purchasedTo,states:inventoryFilters,delivererIds:assigneeFilterIds},!!openColumn||activeColumnCount>0);
  const items=inventory.rows,count=inventory.total,loading=inventory.loading;
  const viewItems=useMemo(()=>filterInventoryColumns(items.filter(item=>matchesInventoryFilters(item,inventoryFilters)),columnFilters),[items,columnFilters,inventoryFilters]);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
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
  const { rows: purchaseDrafts, setRows: setPurchaseDrafts, loading: draftsLoading, error: draftError, setError: setDraftError, updated: draftsUpdated, refresh: loadPurchaseDrafts } = usePurchaseDrafts(fetchPurchaseDrafts, draftsOpen);
  const purchaseSync = usePurchaseSync(loadPurchaseDrafts, me.role === 'admin');
  const [selectedPurchaseDraft, setSelectedPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [dismissingDraft, setDismissingDraft] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<{ item: InventoryItem; field: InventoryField } | null>(null);
  const [fullEditFor, setFullEditFor] = useState<InventoryItem | null>(null);
  const [expandedComment, setExpandedComment] = useState<{ sku: string; label: string; text: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(80);
  const loadMoreRef = useRef<HTMLDivElement>(null);

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

  async function excludeDraft(id: string) {
    if (dismissingDraft) return;
    setDismissingDraft(id); setDraftError(null);
    try { await dismissPurchaseDraft(id); setPurchaseDrafts(rows => rows.filter(row => row.id !== id)); }
    catch (cause) { setDraftError(cause instanceof Error ? cause.message : cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)); }
    finally { setDismissingDraft(null); }
  }

  function clearFilters() {
    setInventoryFilters({}); setColumnFilters({}); setOpenColumn(null); setQueryField('serial');
    setQuery(''); setPurchasedFrom(''); setPurchasedTo(''); setAssigneeFilterIds([]);
  }
  const filterHeading = (field: string) => <button type="button" className={`inventory-column-heading${isColumnFilterActive(columnFilters[field]) ? ' active' : ''}`}
    aria-label={`${inventoryColumns[field]!.label}のフィルター`} aria-expanded={openColumn?.field === field}
    onClick={event => { const anchor = event.currentTarget; setOpenColumn(current => current?.field === field ? null : { field, anchor }); }}>
    {inventoryColumns[field]!.label}<span aria-hidden="true">{isColumnFilterActive(columnFilters[field]) ? ' ▾✓' : ' ▾'}</span>
  </button>;
  const countLabel = loading
    ? (items.length ? `${(activeColumnCount ? productCount(viewItems) : count).toLocaleString()}商品を表示・残りを読み込み中…` : '読み込み中…')
    : `${(activeColumnCount ? productCount(viewItems) : count).toLocaleString()}商品`;
  return (
    <div className={`inventory-workspace${purchaseOpen ? ' with-purchase' : ''}${fullEditFor ? ' with-full-edit' : ''}`}>
      <section className="inventory-list" aria-label="在庫">





      <div className="inventory-controls">
      <div className="inventory-registration-actions">
        <button className="btn primary" aria-expanded={purchaseOpen} aria-controls="inventory-purchase-panel" onClick={() => { setFullEditFor(null); if (purchaseOpen) setSelectedPurchaseDraft(null); setPurchaseOpen(open => !open); }}>
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
        <InventoryStateFilter value={inventoryFilters} onChange={setInventoryFilters} assignee={{value:assigneeFilterIds,options:deliveryStaffOptions(staff).map(person=>({id:person.id,name:staffDisplayName(person)})),onChange:setAssigneeFilterIds}} />
        <div className="inventory-date-range" role="group" aria-label="仕入日の期間">
          <label className="inventory-date-field">
            <DateInput aria-label="仕入日・開始日" placeholder="YY-MM-DD" value={purchasedFrom} max={purchasedTo || undefined} onChange={e => setPurchasedFrom(e.target.value)} />
          </label>
          <span aria-hidden="true">〜</span>
          <label className="inventory-date-field">
            <DateInput aria-label="仕入日・終了日" placeholder="YY-MM-DD" value={purchasedTo} min={purchasedFrom || undefined} onChange={e => setPurchasedTo(e.target.value)} />
          </label>
        </div>
        <button type="button" className="btn inventory-clear-filters" onClick={clearFilters}>全て解除</button>
        <div className="inventory-count" aria-label="在庫の商品件数" aria-live="polite"><span>{countLabel}</span></div>
        {activeColumnCount > 0 && <span className="sub">項目フィルター {activeColumnCount}件</span>}

      </div>
      </div>

      {purchaseOpen && <section ref={purchasePanel} id="inventory-purchase-panel" className="card inventory-purchase-panel registration-sidebar" aria-label="在庫登録" style={{ minWidth: 0 }}>
        <NewPurchase key={selectedPurchaseDraft?.id ?? 'new'} me={me} draft={selectedPurchaseDraft} onSaved={() => { setSelectedPurchaseDraft(null); setPurchaseOpen(false); loadPurchaseDrafts(); void load(); }} />
      </section>}

      {fullEditFor && <InventoryFullEditDialog key={fullEditFor.id} item={fullEditFor} staff={staff} canDelete={me.role === 'admin'} onClose={() => setFullEditFor(null)} onSaved={() => { setFullEditFor(null); void load(); }} />}

      <div className="inventory-data">
      <details className="card purchase-draft-panel" onToggle={event => setDraftsOpen(event.currentTarget.open)}>
        <summary>仕入れリスト（未反映 {purchaseDrafts.length}件）</summary>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={draftsLoading || purchaseSync.syncing || me.role !== 'admin'} onClick={() => void purchaseSync.startSync()}>{purchaseSync.syncing ? '同期中…' : '更新'}</button>
          <span className="sub" role="status" aria-live="polite">{purchaseSync.message || (draftsLoading ? '仕入れリストを読み込んでいます…' : draftsUpdated ? `${draftsUpdated.at} 更新しました（未反映 ${draftsUpdated.count}件）` : '')}</span>
        </div>
        {purchaseSync.error && <div className="error">{purchaseSync.error}</div>}
        {draftError && <div className="error">仕入れリストを読み込めませんでした: {draftError}</div>}
        {purchaseDrafts.length > 0 ? <div className="scroll"><table className="purchase-draft-table"><thead><tr><th>購入日</th><th>商品情報</th><th>仕入先</th><th>購入金額</th><th>商品ID</th><th>販売予定金額</th><th>振込予定金額</th><th>操作</th></tr></thead><tbody>
          {purchaseDrafts.map(draft => <tr key={draft.id}><td>{draft.purchased_at || '要入力'}</td><td><a title={draft.title} href={draft.marketplace_url} target="_blank" rel="noreferrer">{Array.from(draft.title).slice(0, 20).join('')}</a><div className="purchase-draft-product-meta">型番 {draft.model_no || '未特定'} / 品番 {draft.product_no ?? '未特定'} / ASIN {draft.asin || '未特定'}</div></td><td><span className="inventory-label" style={inventorySiteStyle(draft.marketplace)}>{draft.marketplace}</span></td><td>{draft.cost_amount == null ? '要入力' : yen(draft.cost_amount)}</td><td>{draft.marketplace_item_id}</td><td>{draft.planned_price == null ? '未特定' : yen(draft.planned_price)}</td><td>{draft.planned_payout == null ? '未特定' : yen(draft.planned_payout)}</td><td><div className="purchase-draft-actions">
            <button type="button" className="btn primary" onClick={() => { setSelectedPurchaseDraft(draft); setPurchaseOpen(true); window.scrollTo({ top: 0 }); }}>在庫へ反映</button>
            <button type="button" className="btn" disabled={dismissingDraft !== null} onClick={() => void excludeDraft(draft.id)}>{dismissingDraft === draft.id ? '除外中…' : '除外'}</button>
          </div></td></tr>)}
        </tbody></table></div> : !draftError && !draftsLoading && <p className="sub">未反映の購入履歴はありません。</p>}
      </details>
      {me.role === 'admin' && <AmazonOrderHistory />}

      {inventory.error&&<div className="error">{inventory.error}</div>}
      {loading && items.length === 0 && <div className="empty">読み込み中…</div>}
      {!loading && items.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {items.length > 0 && <InventoryOverview items={viewItems.slice(0,visibleCount)} canPrice={me.role==='admin'} heading={filterHeading}
        onEdit={(item,field)=>setEditFor({item,field})}
        onFullEdit={item=>{setPurchaseOpen(false);setFullEditFor(item);}}
        onComment={item=>setExpandedComment({sku:item.sku,label:'納品担当者からのコメント',text:item.latest_comment??''})} />}
      {!loading && items.length > 0 && viewItems.length === 0 && <p className="empty" role="status">フィルターに一致する在庫はありません。フィルターの条件を変更するか、すべて解除してください。</p>}
      {(visibleCount<viewItems.length||inventory.more)&&<div ref={loadMoreRef} className="toolbar"><button className="btn" disabled={loading} onClick={()=>{if(visibleCount<viewItems.length)setVisibleCount(current=>Math.min(current+80,viewItems.length));else {setVisibleCount(current=>current+50);inventory.loadMore();}}}>さらに表示</button></div>}
      </div>
      </section>
      {openColumn && <InventoryColumnFilter key={openColumn.field} field={openColumn.field} anchor={openColumn.anchor} items={items} current={columnFilters[openColumn.field]} onClose={closeColumn} onApply={filter => {
        setColumnFilters(current => { const next = { ...current }; if (filter && isColumnFilterActive(filter)) next[openColumn.field] = filter; else delete next[openColumn.field]; return next; });
        setOpenColumn(null);
      }} />}


      {editFor && <InventoryFieldDialog key={`${editFor.item.id}:${editFor.field}`} item={editFor.item} field={editFor.field} staff={staff} onClose={() => setEditFor(null)} onSaved={() => { setEditFor(null); void load(); }} />}
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
  const [sidebar, setSidebar] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width:1280px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const screen = window.matchMedia('(min-width:1280px)');
    const update = () => setSidebar(screen.matches);
    update(); screen.addEventListener('change', update);
    return () => screen.removeEventListener('change', update);
  }, []);
  const hasUsage = item.is_accessory && canDelete && !productSerial(item.sku,item.lot_seq).endsWith('c');
  const [usageContext,setUsageContext]=useState<AccessoryUsageContext|null>(null);
  const [usageSerial,setUsageSerial]=useState('');
  const [usageError,setUsageError]=useState('');
  const saveState=useRef({locked:false,cardId:''});
  useEffect(()=>{
    if(!hasUsage)return;
    let live=true;
    void fetchAccessoryUsage(item.id).then(context=>{if(live){setUsageContext(context);setUsageSerial(context.serial);}})
      .catch(cause=>{if(live)setUsageError(inventoryError(cause));});
    return()=>{live=false;};
  },[item.id,hasUsage]);
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
      saveState.current.cardId=currentId ?? '';
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
    if (!paymentReady || saveState.current.locked) return;
    saveState.current.locked=true;
    setBusy(true); setError('');
    try {
      const nextUsage=usageSerial.trim().toLowerCase();
      const usageChanged=!!usageContext&&nextUsage!==usageContext.serial;
      if(usageChanged&&(!/^[1-9][0-9]*[a-z]*$/.test(nextUsage)||nextUsage.length>32))throw new Error('利用記録に使用先の通番号を入力してください。');
      const otherChanged=Object.entries(values).some(([field,value])=>value!==item[field as keyof InventoryEdit])
        ||cardId!==saveState.current.cardId||identity.lot_seq!==item.lot_seq||identity.sku!==item.sku
        ||identity.product_no!==item.product_no||identity.model_no!==item.model_no;
      // A usage-only save must not write the old parent's shared fields back
      // after the transfer. Other explicitly edited fields follow the normal save.
      if(!usageChanged||otherChanged){
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
      if (values.asin !== item.asin && (identity.product_no !== item.product_no || identity.model_no !== item.model_no)) {
        current = await fetchInventoryItem(item.id);
      }
      if (identity.product_no !== item.product_no) await updateInventoryField(current, 'product_no', String(identity.product_no ?? ''));
      if (identity.model_no !== item.model_no) await updateInventoryField(current, 'model_no', String(identity.model_no ?? ''));
      }
      if(usageChanged&&usageContext){
        const context=otherChanged?await fetchAccessoryUsage(item.id):usageContext;
        await reassignAccessoryUsage(item.id,nextUsage,context.revision);
      }
      onSaved();
    }
    catch (cause) { setError(inventoryError(cause)); setBusy(false); }
    finally {saveState.current.locked=false;}
  }
  async function remove() {
    const confirmed = window.confirm(`「${item.sku}」を在庫から削除しますか？削除した商品情報は元に戻せません。`);
    if (!confirmed) return;
    setBusy(true); setError('');
    try { await deleteInventoryItem(item); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '削除できませんでした。'); setBusy(false); }
  }
  return <div className="inventory-edit-overlay inventory-full-edit-container" role={sidebar ? 'region' : 'dialog'} aria-modal={sidebar ? undefined : true} aria-label="商品情報編集">
    <div className="card inventory-full-edit-panel"><h3>商品情報編集</h3><p className="sku">{item.sku}</p>
      <div className="grid cols2 inventory-full-edit-fields">
        <label className="field"><span>通番号</span><input type="number" min={1} step={1} value={identity.lot_seq} onChange={event => setIdentity(current => ({ ...current, lot_seq: Number(event.target.value) }))} /></label>
        <label className="field"><span>SKU</span><input type="text" value={identity.sku} onChange={event => setIdentity(current => ({ ...current, sku: event.target.value }))} /></label>
        {hasUsage&&<label className="field"><span>利用記録</span><input type="text" maxLength={32} value={usageSerial} disabled={!usageContext||busy} onChange={event=>setUsageSerial(event.target.value)}/></label>}
        <label className="field"><span>品番</span><input type="number" min={1} step={1} value={identity.product_no ?? ''} onChange={event => setIdentity(current => ({ ...current, product_no: event.target.value ? Number(event.target.value) : null }))} /></label>
        <label className="field"><span>型番</span><input type="text" value={identity.model_no ?? ''} onChange={event => setIdentity(current => ({ ...current, model_no: event.target.value || null }))} /></label>
        <label className="field"><span>支払い方法</span><select value={cardId} disabled={!paymentReady || busy} onChange={event => setCardId(event.target.value)}>
          <option value="">{paymentReady ? '未設定' : '読み込み中…'}</option>
          {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
        </select></label>
        {fullEditFields.map(field => {
        const options = optionsFor(field), current = values[field] ?? '';
        return <label className={`field${field === 'memo' ? ' inventory-full-edit-memo' : ''}`} key={field}><span>{fieldLabels[field]}</span>
          {options ? <ColoredSelect value={field==='sales_channel'?salesChannelLabel(String(current)):String(current)} onChange={event => set(field, event.target.value)}><option value="">未設定</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</ColoredSelect>
            : field === 'memo' ? <textarea value={String(current)} onChange={event => set(field, event.target.value)} />
            : dateFields.has(field)
              ? <DateInput value={String(current)} onChange={event => set(field, event.target.value)} />
              : <input type={numberFields.has(field) ? 'number' : 'text'} min={numberFields.has(field) && field !== 'amazon_refund_amount' ? 0 : undefined} step={numberFields.has(field) ? 1 : undefined} value={String(current)} onChange={event => set(field, event.target.value)} />}
        </label>;
      })}</div>
      {error && <div className="error" role="alert">{error}</div>}
      {usageError&&<div className="error" role="alert">利用記録を読み込めませんでした。{usageError}</div>}
      {paymentError && <div className="error" role="alert">支払い方法を読み込めませんでした。画面を開き直してください。{paymentError}</div>}
      <div className="toolbar inventory-edit-actions"><button className="btn primary" disabled={busy || !paymentReady} onClick={() => void save()}>保存</button>{canDelete && <button className="btn" disabled={busy} onClick={() => void remove()} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>削除</button>}<button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
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
  const initial = field==='sales_channel'?salesChannelLabel(item.sales_channel):item[field]??'';
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
      <div className="toolbar inventory-edit-actions"><button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
    </div>
  </div>;
}
