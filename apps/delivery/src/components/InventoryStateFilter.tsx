import { useEffect, useRef } from 'react';
import { INVENTORY_FILTER_GROUPS } from '@bussan/shared';
import type { InventoryFilters } from '@bussan/shared';

export default function InventoryStateFilter({ value, onChange }: { value: InventoryFilters; onChange: (value: InventoryFilters) => void }) {
  const container = useRef<HTMLDetailsElement>(null);
  const count = Object.values(value).reduce((sum, values) => sum + (values?.length ?? 0), 0);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (container.current && !container.current.contains(event.target as Node)) container.current.open = false; };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && container.current?.open) { container.current.open = false; container.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, []);
  return <details ref={container} className="inventory-multi-filter">
    <summary>フィルター{count > 0 ? `（${count}）` : ''}</summary>
    <div className="inventory-multi-filter-panel">
      <button type="button" className="btn" onClick={() => onChange({})}>すべて解除</button>
      {INVENTORY_FILTER_GROUPS.map(group => <fieldset key={group.field}>
        <legend>{group.label}</legend>
        {group.values.map(option => <label key={option}><input type="checkbox" checked={value[group.field]?.includes(option) ?? false} onChange={event => {
          const selected = value[group.field] ?? [];
          onChange({ ...value, [group.field]: event.target.checked ? [...selected, option] : selected.filter(item => item !== option) });
        }} /><span>{option}</span></label>)}
      </fieldset>)}
    </div>
  </details>;
}
