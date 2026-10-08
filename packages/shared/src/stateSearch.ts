import { MARKETPLACES, SALES_CHANNELS, STATUSES } from './constants';
export const STATE_SEARCH_GROUPS = [
  { field: 'marketplace', label: '仕入先', values: MARKETPLACES },
  { field: 'sales_channel', label: '販売先', values: SALES_CHANNELS },
  { field: 'status', label: '販売状態', values: STATUSES },
] as const;

export function matchesStateSearch(item: { marketplace?: string | null; sales_channel?: string | null; status?: string | null }, query: string): boolean {
  if (!query) return true;
  const separator = query.indexOf(':');
  const group = STATE_SEARCH_GROUPS.find(group => group.field === query.slice(0, separator));
  return !!group && item[group.field] === query.slice(separator + 1);
}
