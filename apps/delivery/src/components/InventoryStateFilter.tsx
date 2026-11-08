import { useEffect, useRef } from 'react';
import { INVENTORY_FILTER_GROUPS } from '@bussan/shared';
import type { InventoryFilters } from '@bussan/shared';

type AssigneeFilter = { value: string[]; options: { id: string; name: string }[]; onChange: (ids: string[]) => void };
export default function InventoryStateFilter({ value, onChange, assignee }: { value: InventoryFilters; onChange: (value: InventoryFilters) => void; assignee?: AssigneeFilter }) {
  const container = useRef<HTMLDetailsElement>(null);
  const count = Object.values(value).reduce((sum, values) => sum + (values?.length ?? 0), 0) + (assignee?.value.length ?? 0);
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
      {assignee && <fieldset className="inventory-assignee-filter"><legend>納品担当者</legend>
        {assignee.options.map(person => <label key={person.id}><input type="checkbox" checked={assignee.value.includes(person.id)} onChange={event => assignee.onChange(event.target.checked ? [...assignee.value, person.id] : assignee.value.filter(id => id !== person.id))} /><span>{person.name}</span></label>)}
      </fieldset>}
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
