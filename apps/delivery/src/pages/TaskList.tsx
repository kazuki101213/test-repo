import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeliveryTask, Staff } from '@bussan/shared';
import { fetchAmazonFeed, fetchDeliveryStaff, fetchMyTasks, fetchTaskThumbnails } from '../api';
import { downloadTsv } from '../csv';
import TaskCard from '../components/TaskCard';

type Filter = 'all' | 'arrived' | 'shipped';
const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s‐‑–—−ー]/g, '');

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'arrived', label: '作業中' },
  { key: 'shipped', label: '出荷済' },
  { key: 'all',     label: 'すべて' },
];

export default function TaskList({ staff }: { staff: Staff }) {
  const [tasks, setTasks] = useState<DeliveryTask[]>([]);
  const [deliverers, setDeliverers] = useState<{ id: string; name: string }[]>([]);
  const [delivererId, setDelivererId] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('arrived');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpanded = (id: string) => setExpandedId(current => current === id ? null : id);
  const updateTask = useCallback((updated: DeliveryTask) => {
    setTasks(current => current.map(task => task.id === updated.id ? updated : task));
  }, []);

  async function exportAmazon() {
    if (exporting || selected.size === 0) return;
    setExporting(true); setError(null);
    try {
      const rows = await fetchAmazonFeed();
      const chosen = rows.filter(row => selected.has(String(row.item_id)));
      if (chosen.length !== selected.size) throw new Error('選択した商品に出品準備が未完了の商品が含まれています。商品登録・写真登録などを完了してから出力してください。');
      const cleaned = chosen.map(({ item_id: _id, status: _status, deliverer_id: _deliverer, ...rest }) => rest);
      if (!cleaned.length) throw new Error('出品対象（写真登録まで完了した商品）がありません。');
      downloadTsv(`amazon-listing-${new Date().toISOString().slice(0, 10)}.txt`, cleaned);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  }

  useEffect(() => {
    fetchMyTasks()
      .then(setTasks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (staff.role === 'admin') void fetchDeliveryStaff().then(setDeliverers).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [staff.role]);
  useEffect(() => {
    let active = true;
    if (tasks.length) void fetchTaskThumbnails(tasks).then(urls => { if (active) setThumbnails(urls); }).catch(() => undefined);
    return () => { active = false; };
  }, [tasks]);

  const shown = useMemo(() => {
    const q = normalizeSearch(query);
    const groups = new Map<string, [DeliveryTask, ...DeliveryTask[]]>();
    for (const task of tasks) {
      if (staff.role === 'admin' && delivererId && task.deliverer_id !== delivererId) continue;
      const key = task.lot_seq ? String(task.lot_seq) : task.id;
      const members = groups.get(key);
      if (members) members.push(task);
      else groups.set(key, [task]);
    }
    return [...groups.values()].map(members => ({
      task: members.find(t => !t.is_accessory) ?? members[0],
      members,
    })).filter(({ task: t, members }) => {
      if (q && !members.some(member => [String(member.lot_seq ?? ''), member.sku, member.title].some(value => normalizeSearch(value).includes(q)))) return false;
      const active = ['仕入済', '入荷済', '作業中', 'Amazon返品'].includes(t.status);
      switch (filter) {
        case 'arrived': return active && t.shipped_on === null;
        case 'shipped': return t.shipped_on !== null;
        case 'all':     return true;
      }
    });
  }, [tasks, filter, query, staff.role, delivererId]);

  return (
    <>
      {staff.role === 'admin' && <label className="field"><span>納品担当者の在庫一覧</span><select value={delivererId} onChange={e => { setDelivererId(e.target.value); setExpandedId(null); setSelected(new Set()); }}><option value="">すべての担当者</option>{deliverers.map(deliverer => <option key={deliverer.id} value={deliverer.id}>{deliverer.name}</option>)}</select></label>}
      <input
        type="search" placeholder="通番号 / SKU / 商品名で検索" aria-label="通番号・SKU・商品名を部分一致で検索"
        value={query} onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: 12 }}
      />

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
        <button className="btn" disabled={exporting || shown.length === 0} onClick={() => setSelected(current => new Set([...current, ...shown.map(group => group.task.id)]))}>表示中を選択</button>
        <button className="btn" disabled={exporting || selected.size === 0} onClick={() => setSelected(new Set())}>選択解除</button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && shown.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {shown.map(({ task: t, members }) => <TaskCard key={t.id} task={t} thumbnailUrl={thumbnails[t.id] ?? t.reference_image_url} members={members} staff={staff} expandedId={members.some(member => member.id === expandedId) ? expandedId : null} onOpenMember={toggleExpanded} onClose={() => setExpandedId(null)} onTaskChange={updateTask} selected={selected.has(t.id)} disabled={exporting} onSelect={() => setSelected(current => {
        const next = new Set(current);
        if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
        return next;
      })} onOpen={() => toggleExpanded(t.id)} />)}
    </>
  );
}
