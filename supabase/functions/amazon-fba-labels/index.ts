import {createClient} from 'npm:@supabase/supabase-js@2.45.4';
import {amazonCredentials, AmazonAccountError, type AmazonAccountId} from '../_shared/amazonAccounts.ts';

const marketplace = 'A1VC38T7YXB528';
const endpoint = 'https://sellingpartnerapi-fe.amazon.com';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
class LabelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function accountForLabel(channel: string | null): AmazonAccountId {
  if (channel === 'FBA2') return 'amazon-2';
  if (channel === 'FBA' || channel === 'FBA1') return 'amazon-1';
  throw new LabelError(422, 'FBAの販売先を選択してください。');
}

type Summary = {sellerSku?: string; asin?: string; fnSku?: string; productName?: string};
export function exactFbaLabel(rows: Summary[], sku: string, asin: string) {
  const matches = rows.filter(row => row.sellerSku === sku && row.asin === asin);
  const codes = [...new Set(matches.map(row => row.fnSku))];
  if (codes.length !== 1 || !/^X[A-Z0-9]{9}$/.test(codes[0] ?? '')) {
    throw new LabelError(409, 'AmazonでこのSKUのFNSKUを確認できません。FBA登録と反映状況を確認してください。');
  }
  return {fnsku: codes[0]!, title: matches.find(row => row.productName?.trim())?.productName?.trim()};
}

export function matchingAliasSku(rows: Summary[], aliases: string[], asin: string) {
  const matches = [...new Set(rows.flatMap(row =>
    row.sellerSku && row.asin === asin && aliases.includes(row.sellerSku) ? [row.sellerSku] : []
  ))];
  return matches.length === 1 ? matches[0] : null;
}

type ImageGroup = {marketplaceId?: string; images?: {variant?: string; link?: string}[]};
export function catalogPhoto(groups: ImageGroup[]) {
  return groups.find(group => group.marketplaceId === marketplace)?.images?.find(image =>
    image.variant === 'MAIN' && /^https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\//i.test(image.link ?? '')
  )?.link ?? null;
}

export async function handler(req: Request): Promise<Response> {
  const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), {status, headers});
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers});
  if (req.method !== 'POST') return reply(405, {error: 'POSTのみ利用できます。'});
  try {
    const authorization = req.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) throw new LabelError(401, 'ログインが必要です。');
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: {headers: {Authorization: authorization}},
      auth: {persistSession: false, autoRefreshToken: false}, db: {schema: 'app'},
    });
    const {data: user, error: authError} = await sb.auth.getUser(token);
    if (authError || !user.user) throw new LabelError(401, '再ログインしてください。');
    const input = await req.json().catch(() => null);
    if (!uuid(input?.itemId)) throw new LabelError(400, '商品指定が不正です。');
    const [itemResult, staffResult, adminResult] = await Promise.all([
      sb.from('v_items').select('sku,asin,title,model_no,condition,sales_channel,deliverer_id,status,is_accessory').eq('id', input.itemId).maybeSingle(),
      sb.rpc('current_staff_id'),
      sb.rpc('is_admin'),
    ]);
    const item = itemResult.data;
    if (!item || itemResult.error) throw new LabelError(404, '対象商品を確認できません。');
    if (staffResult.error || adminResult.error || !staffResult.data) throw new LabelError(403, '利用権限を確認できません。');
    const staff = await sb.from('staff').select('is_active').eq('id', staffResult.data).maybeSingle();
    if (staff.error || !staff.data?.is_active || (adminResult.data !== true && item.deliverer_id !== staffResult.data)) {
      throw new LabelError(403, 'この商品のラベル印刷権限がありません。');
    }
    if (typeof input.expectedSku !== 'string' || !input.expectedSku || item.sales_channel !== input.expectedChannel ||
        item.status !== '商品登録前' || (item.is_accessory && !/^\d+c+(?:[-_])/i.test(item.sku))) {
      throw new LabelError(409, '商品の状態が変わりました。在庫で選び直してください。');
    }
    if (!/^[A-Z0-9]{10}$/.test(item.asin ?? '') || !item.condition) throw new LabelError(422, '商品のASINとコンディションを確認してください。');
    const account = accountForLabel(item.sales_channel);
    const planUsesHistoricalSku = item.sku !== input.expectedSku;
    if (planUsesHistoricalSku) {
      const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
        auth: {persistSession: false, autoRefreshToken: false}, db: {schema: 'app'},
      });
      // An existing plan needs labels for the seller SKU Amazon accepted for its manifest.
      const [alias, reservation] = await Promise.all([
        sb.from('item_sku_aliases').select('sku').eq('item_id', input.itemId).eq('sku', input.expectedSku).maybeSingle(),
        service.from('fba_inbound_items')
          .select('sku,fba_inbound_plans!inner(id)')
          .eq('item_id', input.itemId).eq('sku', input.expectedSku)
          .eq('asin', item.asin).eq('condition', item.condition).eq('sales_channel', item.sales_channel)
          .is('released_at', null).is('published_at', null)
          .eq('fba_inbound_plans.account', account === 'amazon-2' ? 'FBA2' : 'FBA1')
          .eq('fba_inbound_plans.staff_id', item.deliverer_id)
          .neq('fba_inbound_plans.stage', 'cancelled').maybeSingle(),
      ]);
      if (alias.error || reservation.error) throw new LabelError(502, '納品プランと商品のSKU履歴を確認できませんでした。');
      if (!alias.data || !reservation.data) throw new LabelError(409, '商品の状態が変わりました。在庫で選び直してください。');
    }
    const credentials = amazonCredentials(account);
    const lwa = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'refresh_token', client_id: credentials.clientId,
        client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken}),
      signal: AbortSignal.timeout(10000),
    });
    if (!lwa.ok) throw new LabelError(502, 'Amazonの認可を確認してください。');
    const accessToken = (await lwa.json()).access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new LabelError(502, 'Amazonの認可応答が不正です。');
    const get = (path: string, params: URLSearchParams) => fetch(endpoint + path + '?' + params, {
      headers: {'x-amz-access-token': accessToken, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), 'User-Agent': 'BussanDelivery/1.0 (Language=TypeScript; Platform=Supabase)'},
      signal: AbortSignal.timeout(10000),
    });
    const readSummaries = async (skus: string[]): Promise<Summary[]> => {
      const result = await get('/fba/inventory/v1/summaries', new URLSearchParams({
        granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace, sellerSkus: skus.join(','),
      }));
      if (!result.ok) throw new LabelError(502, result.status === 403
        ? 'AmazonのFBA在庫へのアクセス権限を確認してください。'
        : 'AmazonからFNSKUを取得できません。時間をおいて再試行してください。');
      const summaries = (await result.json()).payload?.inventorySummaries;
      if (!Array.isArray(summaries)) throw new LabelError(502, 'AmazonのFBA在庫応答が不正です。');
      return summaries;
    };
    let sku: string = input.expectedSku;
    let summaries = await readSummaries([sku]);
    if (!planUsesHistoricalSku && !summaries.some(row => row.sellerSku === sku && row.asin === item.asin)) {
      const aliases = await sb.from('item_sku_aliases').select('sku').eq('item_id', input.itemId).neq('sku', sku);
      if (aliases.error) throw new LabelError(502, '商品のSKU履歴を確認できません。');
      const historicalSkus = (aliases.data ?? []).map(row => row.sku);
      if (historicalSkus.length) {
        const historical: Summary[] = [];
        for (let offset = 0; offset < historicalSkus.length; offset += 50) {
          historical.push(...await readSummaries(historicalSkus.slice(offset, offset + 50)));
        }
        const matchedSku = matchingAliasSku(historical, historicalSkus, item.asin!);
        if (matchedSku) {
          sku = matchedSku;
          summaries = historical;
        }
      }
    }
    const {fnsku, title} = exactFbaLabel(summaries, sku, item.asin!);
    let image: string | null = null;
    if (input.includePhoto === true) {
      const catalog = await get('/catalog/2022-04-01/items/' + encodeURIComponent(item.asin!), new URLSearchParams({
        marketplaceIds: marketplace, includedData: 'images',
      })).catch(() => null);
      if (catalog?.ok) {
        const product = await catalog.json().catch(() => null);
        if (product?.asin === item.asin && Array.isArray(product.images)) image = catalogPhoto(product.images);
      }
    }
    return reply(200, {fnsku, title: title || item.title, modelNo: item.model_no, condition: item.condition, image});
  } catch (error) {
    return error instanceof LabelError || error instanceof AmazonAccountError ? reply(error.status, {error: error.message})
      : reply(502, {error: '商品ラベル情報を取得できません。時間をおいて再試行してください。'});
  }
}
if (import.meta.main) Deno.serve(handler);
