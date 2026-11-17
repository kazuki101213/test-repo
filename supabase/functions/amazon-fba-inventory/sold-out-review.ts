import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { japanMarketplace } from '../amazon-sale-notices/orders.ts';

export const amazon2Seller = 'A3E7BXJWH9TP11';
type Get = (path: string, params: URLSearchParams) => Promise<unknown>;
type Db = SupabaseClient<any, 'app', any>;
type Obj = Record<string, unknown>;
const row = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const records = (value: unknown): Obj[] => Array.isArray(value) ? value.map(row) : [];
const qty = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const timestamp = (value: unknown) => {
  const input = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) return null;
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
};
const jstDay = (ms: number) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const day = (value: unknown) => {
  const s = text(value);
  const date = new Date(s + 'T00:00:00Z');
  return /^20\d{2}-\d{2}-\d{2}$/.test(s) && Number.isFinite(+date) && isoDay(date) === s ? s : null;
};
export function nextMonthDay(value: string) {
  const [year, month, date] = value.split('-').map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoDay(new Date(Date.UTC(year, month, Math.min(last, date))));
}

const orderPath = '/orders/2026-01-01/orders';
const inventoryPath = '/fba/inventory/v1/summaries';
const listingPath = '/listings/2021-08-01/items/' + amazon2Seller + '/';
const financePath = '/finances/2024-06-19/transactions';
const orderId = (value: unknown) => /^\d{3}-\d{7}-\d{7}$/.test(text(value));

export function listingEvidence(raw: unknown, sku: string, asin: string, now: number) {
  const listing = row(raw);
  const summaries = records(listing.summaries).filter(r => r.marketplaceId === japanMarketplace);
  if (listing.sku !== sku || summaries.length !== 1 || summaries[0].asin !== asin) return null;
  const summary = summaries[0];
  const changed = timestamp(summary.lastUpdatedDate);
  const created = timestamp(summary.createdDate);
  const validDates = created !== null && changed !== null && created <= changed && changed <= now;
  const statuses = Array.isArray(summary.status) && summary.status.every(tag => tag === 'BUYABLE' || tag === 'DISCOVERABLE')
    ? summary.status.slice().sort() as string[] : null;
  const availability = records(listing.fulfillmentAvailability);
  const defaultStock = availability.filter(r => r.fulfillmentChannelCode === 'DEFAULT');
  const merchantStock = defaultStock.length === 1 ? qty(defaultStock[0].quantity) : null;
  const otherChannel = availability.some(r => !['DEFAULT', 'AMAZON_JP'].includes(text(r.fulfillmentChannelCode)));
  return { changed: validDates ? changed : null, created: validDates ? created : null, statuses, merchantStock, otherChannel,
    fba: availability.some(r => r.fulfillmentChannelCode === 'AMAZON_JP'), used: /^used_/.test(text(summary.conditionType)),
    conditionKnown: text(summary.conditionType) !== '' };
}

export function fbaEvidence(raw: unknown, sku: string, asin: string) {
  const response = row(raw);
  const summaries = records(row(response.payload).inventorySummaries);
  if (row(response.pagination).nextToken != null || summaries.length !== 1) return null;
  const stock = summaries[0];
  const fnsku = text(stock.fnSku);
  if (stock.sellerSku !== sku || stock.asin !== asin || !/^[A-Z0-9]{10}$/.test(fnsku)) return null;
  const d = row(stock.inventoryDetails);
  const totals = {
    total: qty(stock.totalQuantity), available: qty(d.fulfillableQuantity),
    reserved: qty(row(d.reservedQuantity).totalReservedQuantity), working: qty(d.inboundWorkingQuantity),
    shipped: qty(d.inboundShippedQuantity), receiving: qty(d.inboundReceivingQuantity),
    unfulfillable: qty(row(d.unfulfillableQuantity).totalUnfulfillableQuantity),
    researching: qty(row(d.researchingQuantity).totalResearchingQuantity),
  };
  return { fnsku, totals, missing: Object.values(totals).includes(null), positive: Object.values(totals).some(n => n !== null && n > 0) };
}

async function pages(get: Get, path: string, params: URLSearchParams, read: (page: Obj) => { rows: unknown; next: unknown }, tokenKey: string) {
  const result: Obj[] = [];
  const seen = new Set<string>();
  do {
    const page = read(row(await get(path, params)));
    if (!Array.isArray(page.rows)) throw Error('Invalid page');
    result.push(...page.rows.map(row));
    if (page.next == null) return result;
    if (typeof page.next !== 'string' || !page.next || seen.has(page.next) || seen.size >= 7) throw Error('Incomplete pagination');
    seen.add(page.next);
    params.set(tokenKey, page.next);
  } while (true);
}

export function readOrders(orders: Obj[], sku: string, asin: string) {
  const matches = new Map<string, Obj>();
  let incomplete = false, open = false;
  for (const order of orders) {
    if (row(order.salesChannel).marketplaceId !== japanMarketplace || !Array.isArray(order.orderItems)) {
      incomplete = true;
      continue;
    }
    for (const item of records(order.orderItems)) {
      const product = row(item.product);
      if (!text(product.sellerSku) && (!text(product.asin) || product.asin === asin)) incomplete = true;
      if (product.sellerSku !== sku) continue;
      if (product.asin !== asin || !orderId(order.orderId)) { incomplete = true; continue; }
      const fulfillment = row(order.fulfillment);
      const line = row(item.fulfillment);
      if (fulfillment.fulfillmentStatus === 'CANCELLED' || line.fulfillmentStatus === 'CANCELLED') continue;
      if (fulfillment.fulfillmentStatus !== 'SHIPPED') open = true;
      if (fulfillment.fulfillmentStatus === 'SHIPPED' && (qty(item.quantityOrdered) === null ||
        qty(item.quantityOrdered) === 0 || qty(line.quantityFulfilled) !== qty(item.quantityOrdered))) incomplete = true;
      matches.set(text(order.orderId), order);
    }
  }
  return { matches, incomplete, open };
}

async function history(db: Db, sku: string) {
  const aliases = await db.from('item_sku_aliases').select('item_id').eq('sku', sku).limit(2);
  if (aliases.error) throw Error('SKU history');
  const query = () => db.from('items').select('id,sku,asin,sales_channel,sold_on,updated_at')
    .in('sales_channel', ['FBA2', '自己発送2']);
  const direct = await query().eq('sku', sku).limit(2);
  if (direct.error) throw Error('SKU history');
  const ids = aliases.data.map(item => text(item.item_id));
  const past = ids.length ? await query().in('id', ids) : { data: [], error: null };
  if (past.error) throw Error('SKU history');
  return [...new Map([...direct.data, ...past.data].map(item => [item.id, item])).values()];
}

export async function reviewSoldOut(db: Db, get: Get, sku: string) {
  const now = Date.now();
  const today = jstDay(now);
  const excluded: string[] = [];
  const holds: string[] = [];
  const events: string[] = [];
  let asin: string | null = null;
  let listing: ReturnType<typeof listingEvidence> = null;
  let fba: ReturnType<typeof fbaEvidence> = null;
  const result = () => {
    const lastKnownEventOn = events.sort().at(-1) ?? null;
    const reviewOn = lastKnownEventOn && nextMonthDay(lastKnownEventOn);
    if (reviewOn && today < reviewOn) excluded.push('確認できた直近の取引日から暦上1か月経っていません。');
    const state = excluded.length ? 'excluded' : 'hold';
    const evidence = { accountId: 'amazon-2', marketplaceId: japanMarketplace, sku, asin,
      fnsku: fba?.fnsku ?? null, checkedAt: new Date(now).toISOString(),
      listingUpdatedAt: typeof listing?.changed === 'number' ? new Date(listing.changed).toISOString() : null,
      merchantStock: listing?.merchantStock ?? null, fbaStock: fba?.totals ?? null,
      lastKnownEventOn, reviewOn, state, reasons: [...new Set([...excluded, ...holds])] };
    console.info('amazon2_sold_out_review', JSON.stringify(evidence));
    return evidence;
  };
  const stocks = await history(db, sku).catch(() => null);
  if (!stocks || stocks.length !== 1 || !/^[0-9A-Z]{10}$/.test(text(stocks[0]?.asin).trim())) {
    holds.push('管理アプリでSKU・ASINが一致するAmazon2の商品を1件に特定できません。');
    return result();
  }
  const appItem = stocks[0];
  asin = text(appItem.asin).trim();
  const soldOn = day(appItem.sold_on);
  if (!soldOn || soldOn > today) {
    holds.push('管理アプリの販売日を確認できません。');
    return result();
  }
  events.push(soldOn);
  const listingParams = new URLSearchParams({ marketplaceIds: japanMarketplace, includedData: 'summaries,fulfillmentAvailability' });
  const readListing = async () => listingEvidence(await get(listingPath + encodeURIComponent(sku), listingParams), sku, asin!, now);
  listing = await readListing().catch(() => null);
  if (!listing) { holds.push('Amazon2で同じSKU・ASINの出品を確認できません。'); return result(); }
  if (listing.conditionKnown && !listing.used) excluded.push('Amazonで中古品として確認できません。');
  if (!listing.conditionKnown || !listing.statuses || listing.otherChannel || listing.changed === null) holds.push('出品の状態・販売経路・更新日時に確認できない情報があります。');
  if (listing.statuses?.includes('BUYABLE') || (listing.merchantStock ?? 0) > 0)
    excluded.push('Amazonで購入可能、または自己発送在庫が残っています。');
  if (listing.created !== null && jstDay(listing.created) > soldOn) excluded.push('販売日より後に作成された出品です。');
  if (excluded.length) return result();

  if (listing.merchantStock === null) holds.push('自己発送在庫の数量を確認できません。');
  const checkFba = appItem.sales_channel === 'FBA2' || listing.fba;
  const fbaParams = new URLSearchParams({ granularityType: 'Marketplace', granularityId: japanMarketplace,
    marketplaceIds: japanMarketplace, sellerSkus: sku, details: 'true' });
  fba = await get(inventoryPath, fbaParams).then(value => fbaEvidence(value, sku, asin!)).catch(() => null);
  if (fba?.positive) { excluded.push('FBAに在庫・引当・納品中・販売不可・調査中の数量が残っています。'); return result(); }
  if (!fba || fba.missing) holds.push('FBAのSKU・FNSKU・在庫内訳をすべて確認できません。');

  // Start at the recorded sale day. A truncated result can never establish that orders are clear.
  const params = new URLSearchParams({ marketplaceIds: japanMarketplace, includedData: 'FULFILLMENT',
    lastUpdatedAfter: new Date(soldOn + 'T00:00:00+09:00').toISOString(), maxResultsPerPage: '100' });
  const [orders, returns] = await Promise.allSettled([
    pages(get, orderPath, params, p => ({ rows: p.orders, next: row(p.pagination).nextToken }), 'paginationToken'),
    db.from('amazon_fba_customer_returns').select('returned_on').eq('account_id', 'amazon-2').eq('source_sku', sku)
      .order('returned_on', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (returns.status === 'fulfilled' && !returns.value.error) {
    const returnedOn = day(returns.value.data?.returned_on);
    if (returnedOn && returnedOn <= today) events.push(returnedOn);
    else if (returns.value.data) holds.push('FBAの返品受領日を確認できません。');
  } else holds.push('取り込み済みのFBA返品受領日を取得できません。');
  if (orders.status === 'fulfilled') {
    const matching = readOrders(orders.value, sku, asin);
    if (matching.open) holds.push('未発送・一部発送・処理中の注文が残っています。');
    if (matching.incomplete || matching.matches.size !== 1) holds.push('注文・出荷を1件に確定できません。');
    for (const [id, order] of [...matching.matches].slice(0, 1)) {
      const purchased = timestamp(order.createdTime);
      if (purchased !== null && purchased <= now) events.push(jstDay(purchased));
      else holds.push('Amazonの注文日を確認できません。');
      try {
        const payments = await pages(get, financePath, new URLSearchParams({ marketplaceId: japanMarketplace,
          relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: id }),
        p => ({ rows: row(p.payload).transactions, next: row(p.payload).nextToken }), 'nextToken');
        let shipment = false;
        for (const payment of payments) {
          if (!['RELEASED', 'DEFERRED_RELEASED'].includes(text(payment.transactionStatus))) {
            holds.push('保留中または状態不明の取引が残っています。');
            continue;
          }
          const posted = timestamp(payment.postedDate);
          if (posted === null || posted > now) holds.push('支払い・返金・調整の処理日を確認できません。');
          else {
            events.push(jstDay(posted));
            shipment ||= payment.transactionType === 'Shipment';
          }
        }
        if (!shipment) holds.push('確定した注文に対する支払いを確認できません。');
      } catch { holds.push('取引の支払い・返金・調整を最後まで取得できません。'); }
    }
  } else holds.push('Amazonの注文一覧を最後まで取得できません。');

  // The data above may prove a blocker. It cannot establish that these processes are all clear.
  holds.push('出荷完了日と、進行中の顧客返品の有無を確認できません。');
  if (checkFba) holds.push('FBAの納品予定・返送・所有権放棄の未完了分を確認できません。');
  const [latest, latestApp] = await Promise.all([readListing().catch(() => null), history(db, sku).catch(() => null)]);
  if (!latest || JSON.stringify(latest) !== JSON.stringify(listing) ||
      !latestApp || latestApp.length !== 1 || latestApp[0].id !== appItem.id || latestApp[0].updated_at !== appItem.updated_at) {
    holds.push('照合中に出品・管理アプリの情報が変わったか、再取得できませんでした。');
  }
  return result();
}
