import { productModelText, staffDisplayName } from '@bussan/shared';
import type { InventoryItem } from './api';
import { productSerial } from './inventory';

export interface ColumnFilter { values: string[] | null; from: string; to: string }
export type ColumnFilters = Record<string, ColumnFilter>;
export interface InventoryColumn { label: string; kind?: 'number' | 'date'; value: (item: InventoryItem) => string | number | null | undefined }
export const salePrice = (i: InventoryItem) => i.is_accessory || i.product_sale_conflict ? i.sold_price : i.product_sold_price;
export const salePayout = (i: InventoryItem) => i.is_accessory || i.product_sale_conflict ? i.payout_amount : i.product_payout_amount;
export const inventoryColumns: Record<string, InventoryColumn> = {
  photo: { label: 'Amazonの写真', value: i => i.amazon_image_url ? 'あり' : 'なし' },
  serial: { label: '通番号', value: i => productSerial(i.sku, i.lot_seq) },
  product_no: { label: '品番', kind: 'number', value: i => i.product_no },
  sku: { label: 'SKU', value: i => i.sku },
  asin: { label: 'ASIN', value: i => i.asin },
  model: { label: '型番', value: i => i.is_accessory ? i.title : productModelText(i) },
  purchaser: { label: '仕入担当者', value: i => staffDisplayName(i.purchaser_name) },
  deliverer: { label: '納品担当者', value: i => staffDisplayName(i.deliverer_name) },
  marketplace: { label: '仕入先', value: i => i.marketplace },
  item_id: { label: '商品ID', value: i => i.marketplace_item_id },
  tracking: { label: '追跡番号', value: i => i.tracking_no },
  purchased_at: { label: '仕入日', kind: 'date', value: i => i.purchased_at },
  cost: { label: '仕入金額', kind: 'number', value: i => i.cost_amount },
  sales_channel: { label: '販売先', value: i => i.sales_channel },
  condition: { label: '商品状態', value: i => i.condition },
  packed_on: { label: '梱包日', kind: 'date', value: i => i.packed_on },
  shipped_on: { label: '出荷日', kind: 'date', value: i => i.shipped_on },
  planned_price: { label: '販売予定金額', kind: 'number', value: i => i.planned_price },
  planned_payout: { label: '振込予定金額', kind: 'number', value: i => i.planned_payout },
  expected_profit: { label: '見込利益額', kind: 'number', value: i => i.expected_profit },
  expected_rate: { label: '予定利益率', kind: 'number', value: i => i.planned_price && i.expected_profit !== null ? Number((i.expected_profit / i.planned_price * 100).toFixed(1)) : null },
  sold_on: { label: '販売日', kind: 'date', value: i => i.product_sale_conflict ? i.sold_on : i.product_sold_on },
  sold_days: { label: '販売日数', kind: 'number', value: i => i.product_sold_on && i.purchased_at
    ? Math.round((Date.parse(`${i.product_sold_on}T00:00:00Z`) - Date.parse(`${i.purchased_at}T00:00:00Z`)) / 86400000) : i.days_in_stock ?? i.days_to_sell },
  sold_price: { label: '販売金額', kind: 'number', value: salePrice },
  payout: { label: '振込金額', kind: 'number', value: salePayout },
  profit: { label: '利益額', kind: 'number', value: i => i.product_profit },
  rate: { label: '利益率', kind: 'number', value: i => i.product_sold_price && i.product_sold_price > 0 && i.product_profit !== null ? Number((i.product_profit / i.product_sold_price * 100).toFixed(1)) : null },
  inventory_refund: { label: '在庫の払い戻し', kind: 'number', value: i => i.inventory_refund_amount },
  other_refund: { label: 'Amazon以外からの返金', kind: 'number', value: i => i.non_amazon_refund_amount },
  amazon_refund: { label: 'Amazon返金金額', kind: 'number', value: i => i.amazon_refund_amount },
  purchaser_comment: { label: '仕入担当者からのコメント', value: i => i.memo },
  comment: { label: '納品担当者からのコメント', value: i => i.latest_comment },
  status: { label: '販売状態', value: i => i.status },
  registration: { label: '登録区分', value: i => i.is_accessory ? '付属品' : '本体' },
};
export const columnValue = (value: string | number | null | undefined) => value == null ? '' : String(value).trim();
export const isColumnFilterActive = (filter?: ColumnFilter) => !!filter && (filter.values !== null || !!filter.from || !!filter.to);
export function filterInventoryColumns(items: InventoryItem[], filters: ColumnFilters): InventoryItem[] {
  const active = Object.entries(filters).filter(([key, f]) => inventoryColumns[key] && isColumnFilterActive(f));
  if (!active.length) return items;
  return items.filter(item => active.every(([key, f]) => {
    const column = inventoryColumns[key]!, value = columnValue(column.value(item));
    if (f.values !== null && !f.values.includes(value)) return false;
    if (f.from || f.to) {
      if (!value) return false;
      if (column.kind === 'number') {
        const number = Number(value);
        return Number.isFinite(number) && (!f.from || number >= Number(f.from)) && (!f.to || number <= Number(f.to));
      }
      return (!f.from || value >= f.from) && (!f.to || value <= f.to);
    }
    return true;
  }));
}
