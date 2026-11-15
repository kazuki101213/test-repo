import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonCredentials, AmazonAccountError, type AmazonAccountId } from '../_shared/amazonAccounts.ts';

const marketplace = 'A1VC38T7YXB528';
const orderUrl = 'https://sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders';
const expectedSeller = { 'amazon-1': 'A1WI3OGPE43N2T', 'amazon-2': 'A3E7BXJWH9TP11' };
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
class ShippingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Obj = Record<string, unknown>;
const record = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const array = (value: unknown): Obj[] => Array.isArray(value) ? value.map(record) : [];
const timestamp = (value: unknown) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const orderIdPattern = /^\d{3}-\d{7}-\d{7}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function matchOpenOrder(value: unknown, skus: Set<string>, asin: string, purchased: number) {
  const order = record(value);
  const fulfillment = record(order.fulfillment);
  const status = fulfillment.fulfillmentStatus;
  if (typeof order.orderId !== 'string' || !orderIdPattern.test(order.orderId) ||
      record(order.salesChannel).marketplaceId !== marketplace || fulfillment.fulfilledBy !== 'MERCHANT' ||
      (status !== 'UNSHIPPED' && status !== 'PARTIALLY_SHIPPED')) return [];
  const created = timestamp(order.createdTime);
  if (!Number.isFinite(created) || created < purchased) return [];
  return array(order.orderItems).flatMap(item => {
    const product = record(item.product);
    const quantities = record(item.fulfillment);
    if (typeof item.orderItemId !== 'string' || !item.orderItemId ||
        typeof product.sellerSku !== 'string' || !skus.has(product.sellerSku) || product.asin !== asin ||
        item.quantityOrdered !== 1 || record(record(item.cancellation).cancellationExecution).cancelledBy ||
        quantities.quantityUnfulfilled === 0 || Number(quantities.quantityFulfilled ?? 0) > 0 ||
        (status === 'PARTIALLY_SHIPPED' && quantities.quantityUnfulfilled !== 1)) return [];
    const deadline = timestamp(record(fulfillment.shipByWindow).latestDateTime);
    return [{ orderId: order.orderId as string, orderItemId: item.orderItemId, amazonSku: product.sellerSku,
      shipBy: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null }];
  });
}

async function findOrder(account: AmazonAccountId, skus: Set<string>, asin: string, purchased: number) {
  const { clientId, clientSecret, refreshToken, sellerId } = amazonCredentials(account);
  if (sellerId !== expectedSeller[account]) throw new ShippingError(503, 'Amazonの販売アカウント設定を確認してください。');
  const authentication = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  const token = authentication.ok ? (await authentication.json()).access_token : null;
  if (typeof token !== 'string' || !token) throw new ShippingError(502, 'Amazonの認可を確認してください。');

  const params = new URLSearchParams({
    marketplaceIds: marketplace, fulfilledBy: 'MERCHANT', fulfillmentStatuses: 'UNSHIPPED,PARTIALLY_SHIPPED',
    includedData: 'FULFILLMENT', createdAfter: new Date(purchased).toISOString(), maxResultsPerPage: '100',
  });
  const candidates = new Map<string, ReturnType<typeof matchOpenOrder>[number]>();
  const visited = new Set<string>();
  for (;;) {
    const response = await fetch(orderUrl + '?' + params, {
      headers: { 'x-amz-access-token': token, 'User-Agent': 'BussanDelivery/1.0' }, signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) throw new ShippingError(429, 'Amazonの注文照会が混み合っています。少し時間をおいて再試行してください。');
    if (!response.ok) throw new ShippingError(502, 'Amazonの注文を取得できません。販売アカウントの接続と権限を確認してください。');
    const page = await response.json();
    if (!Array.isArray(page.orders)) throw new ShippingError(502, 'Amazonの注文一覧を確認できませんでした。');
    for (const order of page.orders) {
      for (const item of matchOpenOrder(order, skus, asin, purchased)) {
        candidates.set(item.orderId + ':' + item.orderItemId, item);
      }
    }
    if (candidates.size > 1) throw new ShippingError(409, '該当する未出荷の注文が複数あります。セラーセントラルで対象を確認してください。');
    const next = page.pagination?.nextToken;
    if (next == null || next === '') break;
    if (typeof next !== 'string' || visited.has(next) || visited.size >= 9) {
      throw new ShippingError(502, 'Amazonの注文一覧を最後まで照合できませんでした。');
    }
    visited.add(next);
    params.set('paginationToken', next);
  }
  if (!candidates.size) throw new ShippingError(404, 'この商品の未出荷注文を確認できませんでした。');
  return [...candidates.values()][0];
}

export async function handler(request: Request): Promise<Response> {
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: 'POSTのみ利用できます。' });
  try {
    const authorization = request.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) throw new ShippingError(401, 'ログインが必要です。');
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } }, db: { schema: 'app' },
    });
    const user = await client.auth.getUser(token);
    if (user.error || !user.data.user) throw new ShippingError(401, '再ログインしてください。');
    const { itemId } = record(await request.json().catch(() => null));
    if (typeof itemId !== 'string' || !uuidPattern.test(itemId)) throw new ShippingError(400, '対象商品を指定してください。');
    const [identity, result] = await Promise.all([
      client.rpc('current_staff_id'),
      client.from('items').select('sku,asin,purchased_at,sales_channel,status,shipped_on,deliverer_id,is_accessory').eq('id', itemId).maybeSingle(),
    ]);
    if (identity.error || !identity.data) throw new ShippingError(403, '利用権限を確認できません。');
    const staff = await client.from('staff').select('role,is_active').eq('id', identity.data).maybeSingle();
    const item = result.data;
    if (result.error || !item) throw new ShippingError(404, '対象商品を確認できません。');
    if (staff.error || !staff.data?.is_active || (staff.data.role !== 'admin' && item.deliverer_id !== identity.data)) {
      throw new ShippingError(403, 'この商品の自己発送を操作できません。');
    }
    const channel = item.sales_channel;
    if (!['自己発送', '自己発送1', '自己発送2'].includes(channel) || item.status !== '取引中' ||
        item.shipped_on || (item.is_accessory && !/^\d+[a-z]*c-/i.test(item.sku))) {
      throw new ShippingError(409, '未出荷で取引中の自己発送商品を選んでください。');
    }
    const purchased = Date.parse(item.purchased_at + 'T00:00:00+09:00');
    if (!Number.isFinite(purchased) || purchased > Date.now() || !/^[A-Z0-9]{10}$/.test(item.asin ?? '')) {
      throw new ShippingError(409, '在庫の仕入日とASINを確認してください。');
    }
    const aliases = await client.from('item_sku_aliases').select('sku').eq('item_id', itemId);
    if (aliases.error || !aliases.data) throw new ShippingError(502, '商品のSKU履歴を確認できませんでした。');
    const account = channel === '自己発送2' ? 'amazon-2' : 'amazon-1';
    const order = await findOrder(account, new Set([item.sku, ...aliases.data.map(row => row.sku)]), item.asin, purchased);
    return reply(200, { orderId: order.orderId, amazonSku: order.amazonSku, shipBy: order.shipBy, account });
  } catch (error) {
    return error instanceof ShippingError || error instanceof AmazonAccountError ? reply(error.status, { error: error.message })
      : reply(502, { error: 'Amazonの注文確認に失敗しました。時間をおいて再試行してください。' });
  }
}

if (import.meta.main) Deno.serve(handler);
