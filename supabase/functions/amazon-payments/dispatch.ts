import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import type { AmazonAccountId } from '../_shared/amazonAccounts.ts';

const marketplace = 'A1VC38T7YXB528';
const days = 86400000;
const orderUrl = 'https://sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders';
const statuses = ['出品中', '取引中', '販売済'];
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const list = (value: unknown): Obj[] => Array.isArray(value) ? value.map(obj) : [];
const jstDay = (milliseconds: number) => new Date(milliseconds + 9 * 3600000).toISOString().slice(0, 10);
const time = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;

export type DispatchEvidence = {
  sku: string;
  asin: string;
  orderId: string;
  orderedOn: string;
  shippedAt: string;
  shippedOn: string;
};

export function orderDispatchEvidence(value: unknown, now = Date.now()): DispatchEvidence[] {
  const order = obj(value), fulfillment = obj(order.fulfillment), created = time(order.createdTime);
  if (obj(order.salesChannel).marketplaceId !== marketplace || fulfillment.fulfilledBy !== 'MERCHANT' ||
      ['CANCELED', 'CANCELLED'].includes(String(fulfillment.fulfillmentStatus)) || !Number.isFinite(created) ||
      typeof order.orderId !== 'string' || !/^\d{3}-\d{7}-\d{7}$/.test(order.orderId)) return [];

  const packages = list(order.packages), items = list(order.orderItems);
  const skuCounts = new Map<unknown, number>();
  for (const item of items) {
    const sku = obj(item.product).sellerSku;
    skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  }

  const result: DispatchEvidence[] = [];
  for (const item of items) {
    const { sellerSku: sku, asin } = obj(item.product);
    if (typeof sku !== 'string' || !sku || typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin) ||
        typeof item.orderItemId !== 'string' || !item.orderItemId || skuCounts.get(sku) !== 1 ||
        item.quantityOrdered !== 1) continue;
    const matches = packages.flatMap(pkg => list(pkg.packageItems)
      .filter(packageItem => packageItem.orderItemId === item.orderItemId)
      .map(packageItem => ({ pkg, quantity: packageItem.quantity })));
    if (matches.length !== 1 || matches[0].quantity !== 1) continue;
    const { pkg } = matches[0];
    const shipped = time(pkg.shipTime);
    if (['CANCELED', 'CANCELLED'].includes(String(obj(pkg.packageStatus).status)) ||
        !Number.isFinite(shipped) || shipped < created || shipped > now) continue;
    result.push({ sku, asin, orderId: order.orderId, orderedOn: jstDay(created),
      shippedAt: new Date(shipped).toISOString(), shippedOn: jstDay(shipped) });
  }
  return result;
}

type Inventory = {
  id: string;
  sku: string;
  asin: string;
  status: string;
  purchased_at: string;
  sold_on: string | null;
  updated_at: string;
};
type Client = SupabaseClient<any, 'app', any>;

export async function syncDispatchDates({
  db, accountId, token, now = Date.now(), fetcher = fetch,
}: { db: Client; accountId: AmazonAccountId; token: string; now?: number; fetcher?: typeof fetch }) {
  const channels = accountId === 'amazon-1' ? ['自己発送1', '自己発送'] : ['自己発送2'];
  const inventory = new Map<string, Inventory>();
  const duplicates = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from('items')
      .select('id,sku,asin,status,purchased_at,sold_on,updated_at')
      .in('sales_channel', channels).in('status', statuses).is('shipped_on', null).not('asin', 'is', null)
      .order('id').range(offset, offset + 499);
    if (error || !data) throw Error('出荷日が未登録の在庫を確認できません。');
    for (const row of data as Inventory[]) {
      if (inventory.has(row.sku)) duplicates.add(row.sku);
      inventory.set(row.sku, row);
    }
    if (data.length < 500) break;
  }
  for (const sku of duplicates) inventory.delete(sku);

  const updated: { sku: string; shippedAt: string; shippedOn: string }[] = [];
  if (!inventory.size) return { checked: 0, updated };

  const params = new URLSearchParams({
    marketplaceIds: marketplace,
    includedData: 'FULFILLMENT,PACKAGES',
    fulfilledBy: 'MERCHANT',
    lastUpdatedAfter: new Date(now - 60 * days).toISOString(),
    lastUpdatedBefore: new Date(now - 3 * 60000).toISOString(),
    maxResultsPerPage: '100',
  });
  const candidates = new Map<string, DispatchEvidence>();
  const ambiguous = new Set<string>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = new URLSearchParams(params);
    if (pageToken) page.set('paginationToken', pageToken);
    const response = await fetcher(orderUrl + '?' + page, {
      headers: { 'x-amz-access-token': token, 'user-agent': 'BussanAdmin/1.0' },
      signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw Error(`Amazon注文APIで出荷日時を取得できません（HTTP ${response.status}）。`);
    const body = await response.json();
    if (!Array.isArray(body.orders)) throw Error('Amazon注文APIの応答に注文一覧がありません。');
    for (const order of body.orders) {
      for (const evidence of orderDispatchEvidence(order, now)) {
        const row = inventory.get(evidence.sku);
        if (!row || row.asin !== evidence.asin || evidence.orderedOn < row.purchased_at ||
            (row.sold_on && evidence.orderedOn !== row.sold_on)) continue;
        const previous = candidates.get(evidence.sku);
        if (previous && (previous.orderId !== evidence.orderId || previous.shippedAt !== evidence.shippedAt)) {
          ambiguous.add(evidence.sku);
        }
        candidates.set(evidence.sku, evidence);
      }
    }
    pageToken = body.pagination?.nextToken;
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 10000 ||
        tokens.has(pageToken) || tokens.size >= 20)) throw Error('Amazon注文APIのページを最後まで照合できません。');
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);

  for (const evidence of candidates.values()) {
    if (ambiguous.has(evidence.sku)) continue;
    const row = inventory.get(evidence.sku)!;
    const { data, error } = await db.rpc('apply_amazon_self_dispatch', {
      p_item: row.id, p_account: accountId, p_sku: row.sku, p_asin: row.asin,
      p_status: row.status, p_updated_at: row.updated_at, p_shipped_on: evidence.shippedOn,
    });
    if (error) throw Error('Amazon自己発送の出荷日を保存できません。再実行できます。');
    if (data === true) updated.push({ sku: evidence.sku, shippedAt: evidence.shippedAt, shippedOn: evidence.shippedOn });
  }
  return { checked: inventory.size, updated };
}
