import { productModelText } from '@bussan/shared';
import type { InventoryItem } from './api';
import { productSerial } from './inventory';

export const inventorySearchFields = [
  { value: 'serial', label: '通番号' },
  { value: 'sku', label: 'SKU' },
  { value: 'model', label: '型番' },
  { value: 'asin', label: 'ASIN' },
  { value: 'marketplace_item_id', label: '商品ID' },
  { value: 'tracking_no', label: '追跡番号' },
] as const;
export type InventorySearchField = typeof inventorySearchFields[number]['value'];

export function matchesInventorySearch(item: InventoryItem, field: InventorySearchField, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const value = field === 'serial' ? productSerial(item.sku, item.lot_seq)
    : field === 'model' ? (item.is_accessory ? item.title : productModelText(item))
    : item[field];
  return String(value ?? '').toLocaleLowerCase().includes(needle);
}
