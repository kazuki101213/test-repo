import ReturnTasks from '../components/ReturnTasks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryInventoryRow, DeliveryTask, Staff, InventoryFilters, ItemStatus } from '@bussan/shared';
import { canViewDeliveryAssignee, deliveryStaffOptions, inventoryPurchaserOptions, inventorySiteStyle, staffDisplayName, matchesInventoryFilters } from '@bussan/shared';
import { fetchInventoryStaff, fetchDeliveryItemNotices, markDeliveryItemNoticesRead, type DeliveryItemNotice, type InventoryStaff } from '../api';
import {useInventoryPage} from '../hooks/useInventoryPage';
import {fetchTask} from '../api';
import DateInput from '../components/DateInput';
import { deliveryErrorMessage } from '../errors';
import InventoryStateFilter from '../components/InventoryStateFilter';
import TaskCard from '../components/TaskCard';
import SpareShippingTasks from '../components/SpareShippingTasks';
import { useTaskViewport } from '../hooks/useTaskViewport';
import { deliverySearchFields, deliverySearchValue, matchesDeliverySearch, normalizeSearch, type DeliverySearchField } from '../deliverySearch';

type Filter = 'all' | 'work' | 'selling' | ItemStatus;
const GROUP_STATUSES: Partial<Record<Filter, ItemStatus[]>> = {
  work: ['受取前', '検品中', '商品登録前'],
  selling: ['出品中', '取引中'],
};
const FILTERS: { key: Filter; label: string }[] = [
  {key:'work',label:'作業中'}, {key:'selling',label:'販売中'},
  {key:'販売済',label:'販売済'}, {key:'Amazon返送依頼',label:'Amazon返品依頼'},
];
const FOOTER_FILTERS: { key: Filter; label: string }[] = [
  {key:'動作不良',label:'動作不良'}, {key:'Amazon補填申請中',label:'Amazon補填申請中'},
  {key:'返品処理',label:'返品処理'}, {key:'all',label:'すべて'},
];

function serialNumber(task: DeliveryTask): string {
  const prefix = task.inventory_group_serial?.trim() || task.sku.match(/^(\d+[a-z]*)-/i)?.[1];
  return prefix?.toLocaleUpperCase() ?? `item:${task.id}`;
}

function baseSerialNumber(task: DeliveryTask): string {
  return task.sku.match(/^(\d+)[a-z]*-/i)?.[1] ?? String(task.lot_seq);
}

function hasSerialSuffix(task: DeliveryTask): boolean {
  return /^\d+[a-z]+-/i.test(task.sku);
}

export default function TaskList({ staff,selectedIds=[],onSelectionChange,onFbaDelivery }: { staff: Staff;selectedIds?:string[];onSelectionChange?:(ids:string[])=>void;onFbaDelivery?:()=>void }) {
  const { sectionRef, shippingRef, viewportHeight } = useTaskViewport();

  const [filterStaff, setFilterStaff] = useState<InventoryStaff[]>([]);
  const deliverers = deliveryStaffOptions(filterStaff);
  const [allProducts, setAllProducts] = useState(false);
  const [delivererId, setDelivererId] = useState('');
  const [assigneeFilterIds, setAssigneeFilterIds] = useState<string[]>([]);
  const [purchaserIds, setPurchaserIds] = useState<string[]>([]);
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');
  const [filter, setFilter] = useState<Filter>(() => canViewDeliveryAssignee(staff) ? 'all' : 'work');
  const [query, setQuery] = useState('');
  const [inventoryFilters, setInventoryFilters] = useState<InventoryFilters>({});
  const [queryField, setQueryField] = useState<DeliverySearchField | 'deliverer'>('serial');
  const [error, setError] = useState<string | null>(null);
  const [replyTaskError, setReplyTaskError] = useState<string | null>(null);
  const [notices, setNotices] = useState<DeliveryItemNotice[]>([]);
  const effectiveDelivererIds = canViewDeliveryAssignee(staff) ? (assigneeFilterIds.length ? assigneeFilterIds : queryField === 'deliverer' && delivererId ? [delivererId] : []) : [];
  const groupedStatuses = GROUP_STATUSES[filter];
  // Use the existing server-side status array, retaining all other filter fields.
  // For disjoint detailed statuses, keep both conditions so the server returns zero.
  const overlappingStatuses = groupedStatuses?.filter(status => !inventoryFilters.status?.length || inventoryFilters.status.includes(status));
  const requestStates = overlappingStatuses?.length ? {...inventoryFilters, status: overlappingStatuses} : inventoryFilters;
  const requestStatus = groupedStatuses ? (overlappingStatuses?.length ? 'all' : groupedStatuses[0]) : filter;
  const inventory=useInventoryPage<DeliveryInventoryRow>(allProducts?'delivery-all':'delivery',staff.id,{status:requestStatus,states:requestStates,queryField,query:queryField==='deliverer'?'':query,purchaserIds,delivererIds:effectiveDelivererIds,from:purchasedFrom,to:purchasedTo});
  const tasks=inventory.rows,loading=inventory.loading;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const detailRevision = 0;
  const deepLinkItemId = new URLSearchParams(window.location.search).get('itemId');
  const deepLinkHandled = useRef(false);
  const toggleExpanded = (id: string) => setExpandedId(current => current === id ? null : id);
  const updateTask = useCallback((updated: DeliveryTask) => {
    window.dispatchEvent(new CustomEvent('delivery-item-workflow-changed',{detail:updated}));
    inventory.updateRow(updated);
  }, [inventory.updateRow]);

  useEffect(()=>{
    if(!deepLinkItemId||deepLinkHandled.current)return;
    let active=true;
    void fetchTask(deepLinkItemId,canViewDeliveryAssignee(staff)).then(item=>{
      if(!active||!item)return;deepLinkHandled.current=true;
      setFilter('all');setInventoryFilters({});setPurchaserIds([]);setAssigneeFilterIds([]);setDelivererId('');setQueryField('sku');setQuery(item.sku);setExpandedId(item.id);
    }).catch(cause=>{if(active)setError(deliveryErrorMessage(cause));});
    return()=>{active=false;};
  },[deepLinkItemId,staff.id]);
  useEffect(()=>{
    let active=true,busy=false;
    const refresh=async()=>{if(busy)return;busy=true;try{const rows=await fetchDeliveryItemNotices();if(active){setNotices(rows);setReplyTaskError(null);}}catch(cause){if(active)setReplyTaskError(deliveryErrorMessage(cause));}finally{busy=false;}};
    void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},300000);
    return()=>{active=false;window.clearInterval(timer);};
  },[staff.id]);
  useEffect(() => {
    let active = true;
    void fetchInventoryStaff().then(rows => { if (active) setFilterStaff(rows); })
      .catch(cause => { if (active) setError(deliveryErrorMessage(cause)); });
    return () => { active = false; };
  }, [staff.id]);

  const shown = useMemo(() => {
    const q = normalizeSearch(query);
    const originalIds = new Map<string, string>();
    for (const task of tasks) {
      if (task.is_accessory || !hasSerialSuffix(task) || task.marketplace === '動作品Amazon返品') continue;
      const original = tasks.find(candidate => !candidate.is_accessory && !hasSerialSuffix(candidate)
        && baseSerialNumber(candidate) === baseSerialNumber(task) && candidate.marketplace_item_id);
      const productId = original?.marketplace_item_id || task.original_marketplace_item_id || task.marketplace_item_id;
      if (productId) originalIds.set(task.id, productId);
    }
    const groups = new Map<string, [DeliveryInventoryRow, ...DeliveryInventoryRow[]]>();
    for (const task of tasks) {
      if (effectiveDelivererIds.length && !effectiveDelivererIds.includes(task.deliverer_id ?? '')) continue;
      const key = serialNumber(task);
      const members = groups.get(key);
      if (members) members.push(task);
      else groups.set(key, [task]);
    }
    const rows = [...groups.values()].map(members => ({
      task: members.find(t => !t.is_accessory) ?? members[0],
      members,
    })).filter(({ task: t, members }) => {
      if (queryField !== 'deliverer' && q && !members.some(member => matchesDeliverySearch(deliverySearchValue(member, queryField, originalIds), queryField, query))) return false;
      if (!members.some(member => matchesInventoryFilters(member, inventoryFilters))) return false;
      return filter === 'all' || members.some(member=>groupedStatuses?groupedStatuses.includes(member.status):member.status===filter);
    });
    return { rows, originalIds };
  }, [tasks, filter, groupedStatuses, query, queryField, staff.role, staff.code, effectiveDelivererIds.join(','), inventoryFilters]);
  const shownRows = shown.rows;
  const canOperate = (task: DeliveryTask) => staff.role === 'admin' || task.deliverer_id === staff.id;
  function selectState(next: Filter) {
    setAllProducts(false);setFilter(next);setExpandedId(null);
  }
  function clearFilters() {
    setQueryField('serial');
    setQuery('');
    setPurchasedFrom('');
    setPurchasedTo('');
    setFilter('all');
    setInventoryFilters({});
    setPurchaserIds([]);
    setAssigneeFilterIds([]);
    setDelivererId('');
    setExpandedId(null);
  }
  function toggleAllProducts() {
    setAllProducts(current => !current);
    clearFilters();
  }
  const noticeRef = useRef(notices);
  noticeRef.current = notices;
  const openingReads = useRef(new Set<string>());
  const acknowledgeOpened = useCallback((itemId: string) => {
    const notice = noticeRef.current.find(row => row.item_id === itemId);
    if (!notice || openingReads.current.has(itemId)) return;
    openingReads.current.add(itemId);
    void markDeliveryItemNoticesRead(notice).then(() => {
      setNotices(current => current.flatMap(row => {
        if (row.item_id !== itemId) return [row];
        const next = { ...row, reply_at: row.reply_at === notice.reply_at ? null : row.reply_at,
          photo_at: row.photo_at === notice.photo_at ? null : row.photo_at };
        return next.reply_at || next.photo_at ? [next] : [];
      }));
      setReplyTaskError(null);
    }).catch(cause => setReplyTaskError(deliveryErrorMessage(cause)))
      .finally(() => openingReads.current.delete(itemId));
  }, []);
  const unreadItemIds = new Set(notices.filter(notice => notice.reply_at || notice.photo_at).map(notice => notice.item_id));

  const fbaActions = onFbaDelivery&&<div className="delivery-fba-actions"><span role="status" aria-live="polite">{selectedIds.length}商品選択</span><button type="button" className="btn" data-direction="forward" disabled={!selectedIds.length} onClick={onFbaDelivery}>FBA納品</button>{selectedIds.length>0&&<button type="button" className="btn ghost" onClick={()=>onSelectionChange?.([])}>選択解除</button>}</div>;

  return (
    <>
      <div className="delivery-inventory-workspace">
      <div className="delivery-inventory-sidebar">
      <div className="delivery-inventory-search" role="group" aria-label="在庫検索">
        <select aria-label="検索項目" data-search-field={queryField} value={queryField} onChange={event => { setQueryField(event.target.value as DeliverySearchField | 'deliverer'); setDelivererId(''); setQuery(''); setExpandedId(null); }}>
          {canViewDeliveryAssignee(staff) && <option value="deliverer">納品担当者</option>}
          {deliverySearchFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
        </select>
        {queryField === 'deliverer' && canViewDeliveryAssignee(staff)
          ? <select aria-label="納品担当者で検索" value={delivererId} onChange={event => { setDelivererId(event.target.value); setAssigneeFilterIds([]); setExpandedId(null); }}><option value="">全員</option>{deliverers.map(deliverer => <option key={deliverer.id} value={deliverer.id}>{staffDisplayName(deliverer)}</option>)}</select>
          : <input type="search" placeholder="検索" aria-label="在庫を検索" value={query} onChange={event => setQuery(event.target.value)} />}
        <div className="delivery-inventory-filter-controls">
          <InventoryStateFilter value={inventoryFilters} purchaser={{
            value: purchaserIds, options: inventoryPurchaserOptions(filterStaff),
            onChange: ids => { setPurchaserIds(ids); setExpandedId(null); },
          }} assignee={canViewDeliveryAssignee(staff) ? {
            value: assigneeFilterIds, options: deliverers.map(person => ({ id: person.id, name: staffDisplayName(person) })),
            onChange: ids => { setAssigneeFilterIds(ids); setDelivererId(''); setExpandedId(null); },
          } : undefined} onChange={value => { setInventoryFilters(value); setFilter('all'); setExpandedId(null); }} />
          <div className="delivery-inventory-date-range" role="group" aria-label="仕入日の期間">
            <DateInput aria-label="仕入日・開始日" value={purchasedFrom} max={purchasedTo || undefined} onChange={e => setPurchasedFrom(e.target.value)} />
            <span aria-hidden="true">〜</span>
            <DateInput aria-label="仕入日・終了日" value={purchasedTo} min={purchasedFrom || undefined} onChange={e => setPurchasedTo(e.target.value)} />
          </div>
          <button type="button" className="btn" onClick={clearFilters}>全て解除</button>
        </div>
      </div>

      <h3 className="delivery-task-heading" id="delivery-task-heading">やること</h3>
      <section ref={sectionRef} className="card delivery-reply-tasks" aria-labelledby="delivery-task-heading" tabIndex={0} style={{ maxHeight: viewportHeight }}>
        <ul className="invoice-task-rows" aria-label="差し戻し"><ReturnTasks staffId={staff.id}/></ul>
        <ul ref={shippingRef} className="invoice-task-rows" aria-label="発送関連"><SpareShippingTasks staff={staff} /></ul>
      </section>
      </div>

      <div className="filters task-filters inventory-workflow-menu" role="group" aria-label="販売状態で絞り込み">
        {['FBA','自己発送','メルカリ','ヤフオク','Amazon返品'].map((channel,index) => <span key={channel} className="inventory-workflow-lane" data-lane={index} style={inventorySiteStyle(channel)}>{channel}</span>)}
        {FILTERS.map((f) => (
          <button
            key={f.key} type="button" className="btn" data-status={f.key} data-active={!allProducts && filter === f.key} aria-pressed={!allProducts && filter === f.key}
            onClick={() => selectState(f.key)}
          >
            <span>{f.label}</span>
          </button>
        ))}
        <div className="inventory-workflow-footer">{FOOTER_FILTERS.map(f => <button key={f.key} type="button" className="btn" data-status={f.key} data-active={!allProducts && filter === f.key} aria-pressed={!allProducts && filter === f.key} onClick={() => selectState(f.key)}>{f.label}</button>)}{['admin','purchaser','deliverer'].includes(staff.role) && <button type="button" className="btn inventory-all-products" data-scope="all" data-active={allProducts} aria-pressed={allProducts} onClick={toggleAllProducts}>全商品</button>}</div>
      </div>
      <div className={'export-actions delivery-inventory-actions'+(shownRows.length ? ' delivery-inventory-actions-with-header' : '')}>
        <span>{inventory.error&&!inventory.hasPage?'件数未取得':`${shownRows.length} / ${inventory.total}商品`}</span>
        {fbaActions}
      </div>
      </div>

      {onFbaDelivery&&shownRows.length>0&&<p className="delivery-fba-mobile-hint">
        {allProducts?'「全商品」は閲覧用です。「作業中」に切り替えると、対象商品を選択できます。':'FBA納品は「商品登録前」のFBA商品を選択できます。'}
      </p>}
      {replyTaskError && <div className="error">{replyTaskError}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {inventory.error && <div className="error" role="alert">{inventory.error} <button type="button" className="btn" onClick={()=>void inventory.refresh()}>再読み込み</button></div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && !inventory.error && shownRows.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {shownRows.length>0&&<div className="approved-delivery-head"><div className="delivery-head-main" aria-hidden="true"><div>販売状況 / 写真・通番号<br/>型番・ASIN / SKU<br/>追跡番号 / 商品ID</div><div>仕入担当者<br/>納品担当者<br/>仕入先<br/>販売先</div><div>コンディション<br/>仕入日<br/>作業完了日<br/>仕入担当者からのコメント</div></div><div className="delivery-head-bundled" aria-hidden="true"><div>付属品<br/>通番号・品名 / 商品ID<br/>追跡番号 / 仕入日・利用記録<br/>仕入担当者からのコメント</div><div>仕入担当者<br/>納品担当者<br/>仕入先<br/>販売先</div></div><div className="delivery-head-action"><span aria-hidden="true">操作</span>{fbaActions}</div></div>}
      {shownRows.map(({ task: t, members }) => <TaskCard key={t.id} task={t} readOnly={allProducts || !members.every(canOperate)} showAssignee={allProducts} amazonImageUrl={t.reference_image_url} members={members} originalMarketplaceIds={shown.originalIds} staff={staff} unreadItemIds={unreadItemIds} onDetailOpened={acknowledgeOpened} detailRevision={detailRevision} expandedId={members.some(member => member.id === expandedId) ? expandedId : null} onOpenMember={toggleExpanded} onClose={() => setExpandedId(null)} onTaskChange={updateTask} onOpen={() => toggleExpanded(t.id)} selection={onSelectionChange?{ids:selectedIds,onChange:onSelectionChange}:undefined} />)}
      {inventory.more&&<button type="button" className="btn" disabled={loading} onClick={inventory.loadMore}>さらに表示</button>}
    </>
  );
}
