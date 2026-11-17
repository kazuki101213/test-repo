import { readTable } from '../amazon-fba-returns/report.ts';

const columns = [
  ['seller-sku', 'asin1', 'fulfillment-channel', 'status'],
  ['seller-sku', 'product-id', 'fulfillment-channel', 'status', 'product-id-type'],
  ['出品者sku', 'asin1', 'フルフィルメント・チャンネル', 'ステータス'],
  ['出品者sku', 'asin1', 'フルフィルメントチャンネル', 'ステータス'],
];

export type SellerListing = { sku: string; asin: string; fulfillment: 'fba' | 'self'; state: 'active' | 'inactive' };

export function parseSellerInventory(tsv: string): { rows: SellerListing[]; unknown: number } {
  let parsed: ReturnType<typeof readTable> | undefined;
  let fields: string[] = [];
  for (const names of columns) {
    try { parsed = readTable(tsv, names); fields = names; break; } catch { /* Try the other documented report locale. */ }
  }
  if (!parsed) throw new Error('全出品レポートのSKU・ASIN・出品ステータスの列を確認できません。');
  const entries = new Map<string, SellerListing>();
  const conflicts = new Set<string>();
  let unknown = 0;
  for (const row of parsed.table) {
    if (row.every(value => !value.trim())) continue;
    const [sku, asin, channel, status, productIdType] = fields.map(name => parsed.field(row, name));
    const channelCode = channel?.toUpperCase();
    const fulfillment = ['AMAZON_JP', 'AFN', 'AMAZON'].includes(channelCode ?? '') ? 'fba'
      : ['DEFAULT', 'MFN', 'MERCHANT', '出品者'].includes(channelCode ?? '') ? 'self' : null;
    const state = /^(active|出品中|有効)$/i.test(status ?? '') ? 'active'
      : /^(inactive(?: \([^)]*\))?|停止中|出品停止中?|無効|在庫切れ)$/i.test(status ?? '') ? 'inactive' : null;
    const isAsin = /^[A-Z0-9]{10}$/.test(asin) &&
      (fields[1] !== 'product-id' || /^(1|ASIN)$/i.test(productIdType));
    if (!sku || !isAsin || !fulfillment || !state) {
      if (sku) conflicts.add(sku);
      unknown++;
      continue;
    }
    const prior = entries.get(sku);
    if (prior && (prior.asin !== asin || prior.fulfillment !== fulfillment || prior.state !== state)) conflicts.add(sku);
    else entries.set(sku, { sku, asin, fulfillment, state });
  }
  for (const sku of conflicts) if (entries.delete(sku)) unknown++;
  return { rows: [...entries.values()], unknown };
}
