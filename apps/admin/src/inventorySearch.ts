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

function normalizeSerialSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

/**
 * 数字だけの通番号は、同じ本体から派生した a/aa/aaa・b・c などの
 * 文字サフィックスをまとめて検索する。サフィックスを入力した場合は
 * これまでどおり、その通番号だけを完全一致で検索する。
 */
export function matchesSerialFamily(candidate: string, query: string): boolean {
  const normalizedCandidate = normalizeSerialSearch(candidate);
  const normalizedQuery = normalizeSerialSearch(query);
  if (!normalizedQuery) return true;
  if (!/^\d+$/.test(normalizedQuery)) return normalizedCandidate === normalizedQuery;
  return new RegExp(`^${normalizedQuery}[a-z]*$`, 'i').test(normalizedCandidate);
}

export function matchesInventorySearch(item: InventoryItem, field: InventorySearchField, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const value = field === 'serial' ? productSerial(item.sku, item.lot_seq)
    : field === 'model' ? (item.is_accessory ? item.title : productModelText(item))
    : item[field];
  const candidate = String(value ?? '').toLocaleLowerCase();
  return field === 'serial' ? matchesSerialFamily(candidate, query) : candidate.includes(needle);
}
