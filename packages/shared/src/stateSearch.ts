import { MARKETPLACES, SALES_CHANNELS, STATUSES } from './constants';
import { PURCHASE_SOURCES, SALES_DESTINATIONS, accountLabelFor } from './marketplaceAccounts';
import { salesChannelLabel } from './salesChannels';
export const INVENTORY_FILTER_GROUPS = [
  { field: 'marketplace', label: '仕入先', values: [...new Set(MARKETPLACES.flatMap(value => [value, ...PURCHASE_SOURCES.filter(label => accountLabelFor(value, label))]))] },
  { field: 'sales_channel', label: '販売先', values: [...new Set(SALES_CHANNELS.flatMap(value => [value, ...SALES_DESTINATIONS.filter(label => accountLabelFor(value, label))]))] },
  { field: 'status', label: '販売状態', values: STATUSES },
] as const;
export type InventoryFilters = Partial<Record<typeof INVENTORY_FILTER_GROUPS[number]['field'], string[]>>;
export function matchesInventoryFilters(item: {
  marketplace?: string | null;
  sales_channel?: string | null;
  status?: string | null;
  purchase_account_label?: string | null;
  sales_account_label?: string | null;
}, filters: InventoryFilters): boolean {
  const matches = {
    marketplace: [item.marketplace, accountLabelFor(item.marketplace, item.purchase_account_label)],
    sales_channel: [salesChannelLabel(item.sales_channel), accountLabelFor(item.sales_channel, item.sales_account_label)],
    status: [item.status],
  };
  return INVENTORY_FILTER_GROUPS.every(({ field }) =>
    !filters[field]?.length || filters[field]!.some(value => matches[field].includes(field === 'sales_channel' ? salesChannelLabel(value) : value)));
}
