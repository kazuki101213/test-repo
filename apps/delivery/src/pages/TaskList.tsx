import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryTask, Staff } from '@bussan/shared';
import { canViewDeliveryAssignee, staffDisplayName } from '@bussan/shared';
import { fetchAmazonFeed, fetchDeliveryStaff, fetchDeliveryItemNotices, fetchMyTasks, markDeliveryItemNoticesRead, type DeliveryItemNotice } from '../api';
import { downloadTsv } from '../csv';
import { deliveryErrorMessage } from '../errors';
import TaskCard from '../components/TaskCard';
import SpareShippingTasks from '../components/SpareShippingTasks';
import { useTaskViewport } from '../hooks/useTaskViewport';
import { deliverySearchFields, deliverySearchValue, normalizeSearch, type DeliverySearchField } from '../deliverySearch';

type Filter = 'all' | 'working' | 'shipped' | 'return-processing' | 'amazon-return' | 'working-amazon-return';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'working', label: '作業中' },
  { key: 'shipped', label: '出荷済' },
  { key: 'return-processing', label: '返品処理' },
  { key: 'amazon-return', label: 'Amazon返品' },
  { key: 'working-amazon-return', label: '動作品Amazon返品' },
  { key: 'all',     label: 'すべて' },
];

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
  const [tasks, setTasks] = useState<DeliveryTask[]>([]);
  const [deliverers, setDeliverers] = useState<{ id: string; name: string }[]>([]);
  const [delivererId, setDelivererId] = useState('');
  const [filter, setFilter] = useState<Filter>(() => staff.name === '長部一輝' ? 'all' : 'working');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [queryField, setQueryField] = useState<DeliverySearchField | 'deliverer'>('serial');
  const [error, setError] = useState<string | null>(null);
  const [replyTaskError, setReplyTaskError] = useState<string | null>(null);
  const [notices, setNotices] = useState<DeliveryItemNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const deepLinkItemId = new URLSearchParams(window.location.search).get('itemId');
  const deepLinkHandled = useRef(false);
  const toggleExpanded = (id: string) => setExpandedId(current => current === id ? null : id);
  const updateTask = useCallback((updated: DeliveryTask) => {
    setTasks(current => current.map(task => task.id === updated.id ? updated : task));
  }, []);

  useEffect(() => {
    if (!deepLinkItemId || deepLinkHandled.current || loading) return;
    const item = tasks.find(row => row.id === deepLinkItemId);
    if (!item) return;
    deepLinkHandled.current = true;
    setFilter('all');
    setQueryField('sku');
    setQuery(item.sku);
    setExpandedId(item.id);
    if (staff.role === 'admin' && item.deliverer_id) setDelivererId(item.deliverer_id);
  }, [deepLinkItemId, loading, tasks, staff.role]);
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

  useEffect(() => {
    let active = true;
    const refresh = async (initial = false) => {
      try {
        const rows = await fetchMyTasks(canViewDeliveryAssignee(staff));
        if (active) { setTasks(rows); setError(null); }
        try {
          const latestNotices = await fetchDeliveryItemNotices();
          if (active) { setNotices(latestNotices); setReplyTaskError(null); }
        } catch (replyError) {
          if (active) setReplyTaskError(deliveryErrorMessage(replyError));
        }
      } catch (e) {
        if (active) setError(deliveryErrorMessage(e));
      } finally {
        if (active && initial) setLoading(false);
      }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh(true);
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);
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
      const productId = original?.marketplace_item_id || task.marketplace_item_id;
      if (productId) originalIds.set(task.id, productId);
    }
    const groups = new Map<string, [DeliveryTask, ...DeliveryTask[]]>();
    for (const task of tasks) {
      if (canViewDeliveryAssignee(staff) && queryField === 'deliverer' && delivererId && task.deliverer_id !== delivererId) continue;
      const key = serialNumber(task);
      const members = groups.get(key);
      if (members) members.push(task);
      else groups.set(key, [task]);
    }
    const rows = [...groups.values()].map(members => ({
      task: members.find(t => !t.is_accessory) ?? members[0],
      members,
    })).filter(({ task: t, members }) => {
      if (queryField !== 'deliverer' && q && !members.some(member => normalizeSearch(deliverySearchValue(member, queryField, originalIds)).includes(q))) return false;
      const active = t.status === '作業中';
      switch (filter) {
        case 'working': return active && t.shipped_on === null;
        case 'shipped': return t.shipped_on !== null;
        case 'return-processing': return members.some(member => member.status === '返品処理');
        case 'amazon-return': return members.some(member => member.marketplace === 'Amazon返品');
        case 'working-amazon-return': return members.some(member => member.marketplace === '動作品Amazon返品');
        case 'all':     return true;
      }
    });
    return { rows, originalIds };
  }, [tasks, filter, query, queryField, staff.role, delivererId]);
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
  const malfunctionTasks = canViewDeliveryAssignee(staff)
    ? tasks.filter(task => task.malfunction_reported && !task.malfunction_resolved_at) : [];
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const visibleNotices = notices.filter(notice => taskById.has(notice.item_id));
  const unreadItemIds = new Set(notices.filter(notice => notice.reply_at || notice.photo_at).map(notice => notice.item_id));
  function openReplyTask(task: DeliveryTask) {
    setFilter('all');
    setQueryField('sku');
    setQuery(task.sku);
    setExpandedId(task.id);
    setDetailRevision(current => current + 1);
    if (staff.role === 'admin') setDelivererId(task.deliverer_id || '');
    window.setTimeout(() => document.getElementById(`delivery-task-${task.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  }

  return (
    <>
      <div className="delivery-inventory-search" role="group" aria-label="在庫検索">
        <select aria-label="検索項目" value={queryField} onChange={event => { setQueryField(event.target.value as DeliverySearchField | 'deliverer'); setDelivererId(''); setQuery(''); setExpandedId(null); setSelected(new Set()); }}>
          {canViewDeliveryAssignee(staff) && <option value="deliverer">納品担当者</option>}
          {deliverySearchFields.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
        </select>
        {queryField === 'deliverer' && canViewDeliveryAssignee(staff)
          ? <select aria-label="納品担当者で検索" value={delivererId} onChange={event => { setDelivererId(event.target.value); setExpandedId(null); setSelected(new Set()); }}><option value="">全員</option>{deliverers.map(deliverer => <option key={deliverer.id} value={deliverer.id}>{staffDisplayName(deliverer)}</option>)}</select>
          : <input type="search" placeholder="検索" aria-label="在庫を検索" value={query} onChange={event => setQuery(event.target.value)} />}
      </div>

      <h3 className="delivery-task-heading" id="delivery-task-heading">タスク</h3>
      <section ref={sectionRef} className="card delivery-reply-tasks" aria-labelledby="delivery-task-heading" tabIndex={0} style={{ maxHeight: viewportHeight }}>
        <ul ref={shippingRef} className="invoice-task-rows" aria-label="発送関連"><SpareShippingTasks staff={staff} /></ul>
        {replyTaskError && <p className="error" role="alert">返信タスクを読み込めませんでした：{replyTaskError}</p>}
        {malfunctionTasks.length > 0 && <ul className="invoice-task-rows" aria-label="動作不良の報告">
          {malfunctionTasks.map(task => <li key={task.id}>
            <button type="button" className="btn delivery-notice-message" onClick={() => openReplyTask(task)}>
              【{task.sku.split('-')[0]}】動作不良の報告が届きました
            </button>
            <div className="spare-shipping-details">
              <span>納品担当者：{task.deliverer_name || '未設定'}</span><span>品名：{task.title}</span>
              <span>{task.malfunction_comment || '報告内容未登録'}</span>
            </div>
          </li>)}
        </ul>}
        {visibleNotices.some(notice => notice.reply_at) && <ul className="invoice-task-rows" aria-label="動作不良の返信">
          {visibleNotices.filter(notice => notice.reply_at).map(notice => <li key={notice.item_id}>
            <button type="button" className="btn delivery-notice-message" onClick={() => openReplyTask(taskById.get(notice.item_id)!)}>
              【{notice.lot_seq}】メッセージが届きました
            </button>
          </li>)}
        </ul>}
        {visibleNotices.some(notice => notice.photo_at) && <ul className="invoice-task-rows" aria-label="写真承認関連">
          {visibleNotices.filter(notice => notice.photo_at).map(notice => <li key={notice.item_id}>
            <button type="button" className="btn delivery-notice-message" onClick={() => openReplyTask(taskById.get(notice.item_id)!)}>
              【{notice.lot_seq}】写真が承認されました。
            </button>
          </li>)}
        </ul>}
      </section>

      <div className="filters task-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key} className="btn" data-active={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="export-actions">
        <button className="btn" disabled={exporting || selected.size === 0} onClick={() => void exportAmazon()}>{exporting ? '出力中…' : `Amazon出品ファイル（${selected.size}件）`}</button>
        <button className="btn" disabled={exporting || shownRows.length === 0} onClick={() => setSelected(current => new Set([...current, ...shownRows.map(group => group.task.id)]))}>表示中を選択</button>
        <button className="btn" disabled={exporting || selected.size === 0} onClick={() => setSelected(new Set())}>選択解除</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && shownRows.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {shownRows.map(({ task: t, members }) => <TaskCard key={t.id} task={t} amazonImageUrl={t.reference_image_url} members={members} originalMarketplaceIds={shown.originalIds} staff={staff} unreadItemIds={unreadItemIds} onDetailOpened={acknowledgeOpened} detailRevision={detailRevision} expandedId={members.some(member => member.id === expandedId) ? expandedId : null} onOpenMember={toggleExpanded} onClose={() => setExpandedId(null)} onTaskChange={updateTask} selected={selected.has(t.id)} disabled={exporting} onSelect={() => setSelected(current => {
        const next = new Set(current);
        if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
        return next;
      })} onOpen={() => toggleExpanded(t.id)} />)}
    </>
  );
}
