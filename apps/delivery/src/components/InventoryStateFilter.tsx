import { useEffect, useRef } from 'react';
import { INVENTORY_FILTER_GROUPS } from '@bussan/shared';
import type { InventoryFilters } from '@bussan/shared';

type AssigneeFilter = { value: string[]; options: { id: string; name: string }[]; onChange: (ids: string[]) => void };
export default function InventoryStateFilter({ value, onChange, purchaser, assignee }: { value: InventoryFilters; onChange: (value: InventoryFilters) => void; purchaser?: AssigneeFilter; assignee?: AssigneeFilter }) {
  const container = useRef<HTMLDetailsElement>(null);
  const assigneeGroups = [{ label: '仕入担当者', filter: purchaser }, { label: '納品担当者', filter: assignee }];
  const count = Object.values(value).reduce((sum, values) => sum + (values?.length ?? 0), 0)
    + assigneeGroups.reduce((sum, { filter }) => sum + (filter?.value.length ?? 0), 0);
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
      {assigneeGroups.map(({ label, filter }) => filter && <fieldset className="inventory-assignee-filter" key={label}>
        <legend>{label}</legend>
        {filter.options.map(person => <label key={person.id}>
          <input type="checkbox" checked={filter.value.includes(person.id)} onChange={event =>
            filter.onChange(event.target.checked ? [...filter.value, person.id] : filter.value.filter(id => id !== person.id))} />
          <span>{person.name}</span>
        </label>)}
      </fieldset>)}
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
