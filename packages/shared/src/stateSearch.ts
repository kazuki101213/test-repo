import { MARKETPLACES, SALES_CHANNELS, STATUSES } from './constants';
export const INVENTORY_FILTER_GROUPS = [
  { field: 'marketplace', label: '仕入先', values: MARKETPLACES },
  { field: 'sales_channel', label: '販売先', values: SALES_CHANNELS },
  { field: 'status', label: '販売状態', values: STATUSES },
] as const;
export type InventoryFilters = Partial<Record<typeof INVENTORY_FILTER_GROUPS[number]['field'], string[]>>;
export function matchesInventoryFilters(item: { marketplace?: string | null; sales_channel?: string | null; status?: string | null }, filters: InventoryFilters): boolean {
  return INVENTORY_FILTER_GROUPS.every(({ field }) => !filters[field]?.length || filters[field]!.includes(item[field] ?? ''));
}
