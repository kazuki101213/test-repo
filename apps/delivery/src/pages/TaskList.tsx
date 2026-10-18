import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryTask, Staff, InventoryFilters, ItemStatus } from '@bussan/shared';
import { canViewDeliveryAssignee, staffDisplayName, matchesInventoryFilters, STATUSES } from '@bussan/shared';
import { fetchAmazonFeed, fetchDeliveryStaff, fetchDeliveryItemNotices, markDeliveryItemNoticesRead, type DeliveryItemNotice } from '../api';
import {useInventoryPage} from '../hooks/useInventoryPage';
import {fetchTask} from '../api';
import { downloadTsv } from '../csv';
import { deliveryErrorMessage } from '../errors';
import InventoryStateFilter from '../components/InventoryStateFilter';
import TaskCard from '../components/TaskCard';
import SpareShippingTasks from '../components/SpareShippingTasks';
import { useTaskViewport } from '../hooks/useTaskViewport';
import { deliverySearchFields, deliverySearchValue, matchesDeliverySearch, normalizeSearch, type DeliverySearchField } from '../deliverySearch';

type Filter = 'all' | ItemStatus;
const FILTERS: { key: Filter; label: string }[] = STATUSES.filter(key => key !== '動作不良' && key !== '返品処理').map(key => ({key,label:key}));
const FOOTER_FILTERS: { key: Filter; label: string }[] = [{key:'all',label:'すべて'},{key:'動作不良',label:'動作不良'},{key:'返品処理',label:'返品処理'}];

function serialNumber(task: DeliveryTask): string {
  const prefix = task.sku.match(/^(\d+[a-z]*)-/i)?.[1];
  return prefix?.toLocaleUpperCase() ?? `item:${task.id}`;
}

function baseSerialNumber(task: DeliveryTask): string {
  return task.sku.match(/^(\d+)[a-z]*-/i)?.[1] ?? String(task.lot_seq);
}

function hasSerialSuffix(task: DeliveryTask): boolean {
  return /^\d+[a-z]+-/i.test(task.sku);
}

export default function TaskList({ staff }: { staff: Staff }) {
  const { sectionRef, shippingRef, viewportHeight } = useTaskViewport();

  const [deliverers, setDeliverers] = useState<{ id: string; name: string }[]>([]);
  const [delivererId, setDelivererId] = useState('');
  const [assigneeFilterId, setAssigneeFilterId] = useState('');
  const [filter, setFilter] = useState<Filter>(() => canViewDeliveryAssignee(staff) ? 'all' : '検品中');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [inventoryFilters, setInventoryFilters] = useState<InventoryFilters>({});
  const [queryField, setQueryField] = useState<DeliverySearchField | 'deliverer'>('serial');
  const [error, setError] = useState<string | null>(null);
  const [replyTaskError, setReplyTaskError] = useState<string | null>(null);
  const [notices, setNotices] = useState<DeliveryItemNotice[]>([]);
  const effectiveDelivererId = canViewDeliveryAssignee(staff) ? assigneeFilterId || (queryField === 'deliverer' ? delivererId : '') : '';
  const inventory=useInventoryPage<DeliveryTask>('delivery',staff.id,{status:filter,states:inventoryFilters,queryField,query:queryField==='deliverer'?'':query,delivererId:effectiveDelivererId});
  const tasks=inventory.rows,loading=inventory.loading;
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const detailRevision = 0;
  const deepLinkItemId = new URLSearchParams(window.location.search).get('itemId');
  const deepLinkHandled = useRef(false);
  const toggleExpanded = (id: string) => setExpandedId(current => current === id ? null : id);
  const updateTask = useCallback((updated: DeliveryTask) => {
    inventory.updateRow(updated);
  }, [inventory.updateRow]);

  useEffect(()=>{
    if(!deepLinkItemId||deepLinkHandled.current)return;
    let active=true;
    void fetchTask(deepLinkItemId,canViewDeliveryAssignee(staff)).then(item=>{
      if(!active||!item)return;deepLinkHandled.current=true;
      setFilter('all');setInventoryFilters({});setAssigneeFilterId('');setDelivererId('');setQueryField('sku');setQuery(item.sku);setExpandedId(item.id);
    }).catch(cause=>{if(active)setError(deliveryErrorMessage(cause));});
    return()=>{active=false;};
  },[deepLinkItemId,staff.id]);
  async function exportAmazon() {
    if (exporting || selected.size === 0) return;
    setExporting(true); setError(null);
    try {
      const rows = await fetchAmazonFeed();
      const chosen = rows.filter(row => selected.has(String(row.item_id)));
      if (chosen.length !== selected.size) throw new Error('選択した商品に出品準備が済んでいない商品が含まれています。商品登録・写真登録などを完了してから出力してください。');
      const cleaned = chosen.map(({ item_id: _id, status: _status, deliverer_id: _deliverer, ...rest }) => rest);
      if (!cleaned.length) throw new Error('出品対象（写真登録まで完了した商品）がありません。');
      downloadTsv(`amazon-listing-${new Date().toISOString().slice(0, 10)}.txt`, cleaned);
    } catch (e) { setError(deliveryErrorMessage(e)); }
    finally { setExporting(false); }
  }

  useEffect(()=>{
    let active=true,busy=false;
    const refresh=async()=>{if(busy)return;busy=true;try{const rows=await fetchDeliveryItemNotices();if(active){setNotices(rows);setReplyTaskError(null);}}catch(cause){if(active)setReplyTaskError(deliveryErrorMessage(cause));}finally{busy=false;}};
    void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},300000);
    return()=>{active=false;window.clearInterval(timer);};
  },[staff.id]);
  useEffect(() => {
    if (staff.role === 'admin') void fetchDeliveryStaff().then(setDeliverers).catch(e => setError(deliveryErrorMessage(e)));
  }, [staff.role]);

  const shown = useMemo(() => {
    const q = normalizeSearch(query);
    const originalIds = new Map<string, string>();
    for (const task of tasks) {
      if (!hasSerialSuffix(task) || task.marketplace === '動作品Amazon返品') continue;
      const original = tasks.find(candidate => !candidate.is_accessory && !hasSerialSuffix(candidate)
        && baseSerialNumber(candidate) === baseSerialNumber(task) && candidate.marketplace_item_id);
      const productId = original?.marketplace_item_id || task.original_marketplace_item_id || task.marketplace_item_id;
      if (productId) originalIds.set(task.id, productId);
    }
    const groups = new Map<string, [DeliveryTask, ...DeliveryTask[]]>();
    for (const task of tasks) {
      if (effectiveDelivererId && task.deliverer_id !== effectiveDelivererId) continue;
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
      return filter === 'all' || t.status === filter;
    });
    return { rows, originalIds };
  }, [tasks, filter, query, queryField, staff.role, staff.code, effectiveDelivererId, inventoryFilters]);
  const shownRows = shown.rows;
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

  return (
    <>
      <div className="delivery-inventory-workspace">
      <div className="delivery-inventory-sidebar">
      <div className="delivery-inventory-search" role="group" aria-label="在庫検索">
        <select aria-label="検索項目" value={queryField} onChange={event => { setQueryField(event.target.value as DeliverySearchField | 'deliverer'); setDelivererId(''); setQuery(''); setExpandedId(null); setSelected(new Set()); }}>
          {canViewDeliveryAssignee(staff) && <option value="deliverer">納品担当者</option>}
          {deliverySearchFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
        </select>
        {queryField === 'deliverer' && canViewDeliveryAssignee(staff)
          ? <select aria-label="納品担当者で検索" value={delivererId} onChange={event => { setDelivererId(event.target.value); setAssigneeFilterId(''); setExpandedId(null); setSelected(new Set()); }}><option value="">全員</option>{deliverers.map(deliverer => <option key={deliverer.id} value={deliverer.id}>{staffDisplayName(deliverer)}</option>)}</select>
          : <input type="search" placeholder="検索" aria-label="在庫を検索" value={query} onChange={event => setQuery(event.target.value)} />}
        <InventoryStateFilter value={inventoryFilters} assignee={canViewDeliveryAssignee(staff) ? {
          value: assigneeFilterId, options: deliverers.map(person => ({ id: person.id, name: staffDisplayName(person) })),
          onChange: id => { setAssigneeFilterId(id); if (queryField === 'deliverer') setDelivererId(id); setExpandedId(null); setSelected(new Set()); },
        } : undefined} onChange={value => { setInventoryFilters(value); setFilter('all'); setExpandedId(null); setSelected(new Set()); }} />
      </div>

      <h3 className="delivery-task-heading" id="delivery-task-heading">やること</h3>
      <section ref={sectionRef} className="card delivery-reply-tasks" aria-labelledby="delivery-task-heading" tabIndex={0} style={{ maxHeight: viewportHeight }}>
        <ul ref={shippingRef} className="invoice-task-rows" aria-label="発送関連"><SpareShippingTasks staff={staff} /></ul>
      </section>
      </div>

      <div className="filters task-filters inventory-workflow-menu" role="group" aria-label="販売状態で絞り込み">
        {['FBA','自己発送','メルカリ','ヤフオク','Amazon返品'].map((channel,index) => <span key={channel} className="inventory-workflow-lane" data-lane={index}>{channel}</span>)}
        {FILTERS.map((f) => (
          <button
            key={f.key} type="button" className="btn" data-status={f.key} data-active={filter === f.key} aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <div className="inventory-workflow-footer">{FOOTER_FILTERS.map(f => <button key={f.key} type="button" className="btn" data-status={f.key} data-active={filter === f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
      </div>
      </div>
      <div className="export-actions">
        <span>{shownRows.length} / {inventory.total}商品</span>
        <button className="btn" disabled={exporting || selected.size === 0} onClick={() => void exportAmazon()}><span className="inventory-desktop-label">{exporting ? '出力中…' : `Amazon出品ファイル（${selected.size}件）`}</span><span className="inventory-mobile-label">{exporting ? '出力中…' : 'Amazon出品ファイル'}</span></button>
        <button className="btn" disabled={exporting || shownRows.length === 0} onClick={() => setSelected(current => new Set([...current, ...shownRows.map(group => group.task.id)]))}><span className="inventory-desktop-label">表示中を選択</span><span className="inventory-mobile-label">全選択</span></button>
        <button className="btn" disabled={exporting || selected.size === 0} onClick={() => setSelected(new Set())}>選択解除</button>
      </div>

      {replyTaskError && <div className="error">{replyTaskError}</div>}
      {(error||inventory.error) && <div className="error">{error||inventory.error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && shownRows.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {shownRows.map(({ task: t, members }) => <TaskCard key={t.id} task={t} amazonImageUrl={t.reference_image_url} members={members} originalMarketplaceIds={shown.originalIds} staff={staff} unreadItemIds={unreadItemIds} onDetailOpened={acknowledgeOpened} detailRevision={detailRevision} expandedId={members.some(member => member.id === expandedId) ? expandedId : null} onOpenMember={toggleExpanded} onClose={() => setExpandedId(null)} onTaskChange={updateTask} selected={selected.has(t.id)} disabled={exporting} onSelect={() => setSelected(current => {
        const next = new Set(current);
        if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
        return next;
      })} onOpen={() => toggleExpanded(t.id)} />)}
      {inventory.more&&<button type="button" className="btn" disabled={loading} onClick={inventory.loadMore}>さらに表示</button>}
    </>
  );
}
