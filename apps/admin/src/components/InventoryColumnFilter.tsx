import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InventoryItem } from '../api';
import { columnValue, inventoryColumns, type ColumnFilter } from '../inventoryFilters';

export default function InventoryColumnFilter({ field, anchor, items, current, onApply, onClose }:
  { field: string; anchor: HTMLElement; items: InventoryItem[]; current?: ColumnFilter; onApply: (filter: ColumnFilter | null) => void; onClose: () => void }) {
  const column = inventoryColumns[field]!;
  const [draft, setDraft] = useState<ColumnFilter>(current ?? { values: null, from: '', to: '' });
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const options = useMemo(() => [...new Set([...items.map(i => columnValue(column.value(i))), ...(current?.values ?? [])])]
    .sort((a, b) => column.kind === 'number' && a && b ? Number(a) - Number(b) : a.localeCompare(b, 'ja', { numeric: true })), [items, column, current]);
  const shown = options.filter(value => (value || '未設定').normalize('NFKC').toLocaleLowerCase().includes(search.normalize('NFKC').toLocaleLowerCase()));
  useEffect(() => {
    searchInput.current?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); anchor.focus(); } };
    const move = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', move);
    window.addEventListener('scroll', move, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); };
  }, [anchor, onClose]);
  function apply() {
    if (draft.from && draft.to && (column.kind === 'number' ? Number(draft.from) > Number(draft.to) : draft.from > draft.to)) { setError('終了値は開始値以上にしてください。'); return; }
    if (column.kind === 'number' && [draft.from, draft.to].some(value => value && !Number.isFinite(Number(value)))) { setError('数値を入力してください。'); return; }
    onApply(draft); anchor.focus();
  }
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 16);
  return createPortal(<div ref={panel} className="inventory-column-filter" role="dialog" aria-label={`${column.label}のフィルター`}
    style={{ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 420)), maxHeight: 'calc(100dvh - 16px)' }}>
    <div className="toolbar"><strong>{column.label}</strong><button type="button" className="btn" onClick={onClose}>閉じる</button></div>
    <input ref={searchInput} type="search" aria-label="フィルター候補を検索" placeholder="候補を検索" value={search} onChange={e => { setSearch(e.target.value); setLimit(100); }} />
    {column.kind && <div className="inventory-column-range">
      <label>開始<input type={column.kind === 'date' ? 'date' : 'number'} step="any" value={draft.from} onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} /></label>
      <span>〜</span><label>終了<input type={column.kind === 'date' ? 'date' : 'number'} step="any" value={draft.to} onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} /></label>
    </div>}
    <div className="inventory-column-values">
      <label><input type="checkbox" checked={draft.values === null} onChange={e => setDraft(d => ({ ...d, values: e.target.checked ? null : [] }))} />すべて</label>
      {shown.slice(0, limit).map(value => <label key={value}><input type="checkbox" checked={draft.values?.includes(value) ?? false} onChange={e => {
        const checked = e.target.checked;
        setDraft(d => ({ ...d, values: checked ? [...new Set([...(d.values ?? []), value])] : (d.values ?? []).filter(v => v !== value) }));
      }} /><span>{value || '未設定'}</span></label>)}
      {!shown.length && <p>一致する候補がありません。</p>}
      {shown.length > limit && <button type="button" className="btn" onClick={() => setLimit(n => n + 100)}>さらに表示</button>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="toolbar"><button type="button" className="btn primary" onClick={apply}>適用</button><button type="button" className="btn" onClick={() => { onApply(null); anchor.focus(); }}>この項目を解除</button></div>
  </div>, document.body);
}
