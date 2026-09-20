import { useEffect, useMemo, useState } from 'react';
import { normalizeSku } from '@bussan/shared';
import type { DeliveryTask } from '@bussan/shared';
import { fetchMyTasks } from '../api';
import TaskCard from '../components/TaskCard';

type Filter = 'all' | 'todo' | 'arrived' | 'shipped';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'todo',    label: '未着手' },
  { key: 'arrived', label: '作業中' },
  { key: 'all',     label: 'すべて' },
  { key: 'shipped', label: '出荷済' },
];

export default function TaskList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<DeliveryTask[]>([]);
  const [filter, setFilter] = useState<Filter>('todo');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMyTasks()
      .then(setTasks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const shown = useMemo(() => {
    const q = normalizeSku(query);
    return tasks.filter((t) => {
      if (q && !normalizeSku(t.sku).includes(q) && !t.title.toUpperCase().includes(q)) return false;
      switch (filter) {
        case 'todo':    return t.arrived_on === null;
        case 'arrived': return t.arrived_on !== null && t.shipped_on === null;
        case 'shipped': return t.shipped_on !== null;
        case 'all':     return true;
      }
    });
  }, [tasks, filter, query]);

  return (
    <>
      <input
        type="search" placeholder="SKU / 商品名で検索"
        value={query} onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: 12 }}
      />

      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key} className="btn" data-active={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="empty">読み込み中…</div>}
      {!loading && shown.length === 0 && <div className="empty">該当する商品はありません。</div>}

      {shown.map((t) => <TaskCard key={t.id} task={t} onOpen={() => onOpen(t.id)} />)}
    </>
  );
}
