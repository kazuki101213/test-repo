import type { SpareAccessory } from './spares';
export const spareSearchFields = [
  { value: 'owner', label: '保管担当者' },
  { value: 'title', label: '品名' },
  { value: 'manufacturer', label: 'メーカー' },
  { value: 'marketplace_item_id', label: '商品ID' },
  { value: 'tracking_no', label: '追跡番号' },
  { value: 'usage_note', label: '利用記録' },
] as const;
export type SpareSearchField = typeof spareSearchFields[number]['value'];
export function matchesSpareSearch(row: SpareAccessory, field: SpareSearchField, query: string, ownerId: string, ownerName?: string): boolean {
  if (field === 'owner') return !ownerId || row.owner_staff_id === ownerId || (!row.owner_staff_id && !!ownerName && row.owner_name === ownerName);
  const normalize = (value: string | null | undefined) => (value || '').normalize('NFKC').toLocaleLowerCase().trim();
  return normalize(row[field]).includes(normalize(query));
}
