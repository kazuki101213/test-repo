import { productModelText } from '@bussan/shared';
import type { DeliveryTask } from '@bussan/shared';

export const deliverySearchFields = [
  { value: 'serial', label: '通番号' },
  { value: 'sku', label: 'SKU' },
  { value: 'model', label: '型番' },
  { value: 'asin', label: 'ASIN' },
  { value: 'marketplace_item_id', label: '商品ID' },
  { value: 'tracking_no', label: '追跡番号' },
] as const;
export type DeliverySearchField = typeof deliverySearchFields[number]['value'];
export const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s‐‑–—−ー]/g, '');

/** Search the same model and product ID that the delivery card displays. */
export function deliverySearchValue(task: DeliveryTask, field: DeliverySearchField, originalIds: Map<string, string>): string {
  if (field === 'serial') return task.sku.match(/^(\d+[a-z]*)-/i)?.[1] ?? String(task.lot_seq ?? '');
  if (field === 'model') return productModelText(task);
  if (field === 'marketplace_item_id') return (task.marketplace === '動作品Amazon返品'
    ? task.marketplace_item_id : originalIds.get(task.id) || task.marketplace_item_id) ?? '';
  return task[field] ?? '';
}

/** 通番号だけは部分一致による別商品の混入を避け、完全一致で検索する。 */
export function matchesDeliverySearch(value: string, field: DeliverySearchField, query: string): boolean {
  const candidate = normalizeSearch(value);
  const needle = normalizeSearch(query);
  if (!needle) return true;
  return field === 'serial' ? candidate === needle : candidate.includes(needle);
}

