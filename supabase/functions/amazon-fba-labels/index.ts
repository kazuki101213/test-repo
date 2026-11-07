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
      sb.from('items').select('sku,asin,title,condition,sales_channel,deliverer_id,status,is_accessory').eq('id', input.itemId).maybeSingle(),
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
    if (item.sku !== input.expectedSku || item.sales_channel !== input.expectedChannel ||
        item.status !== '商品登録前' || (item.is_accessory && !/^\d+c+(?:[-_])/i.test(item.sku))) {
      throw new LabelError(409, '商品の状態が変わりました。在庫で選び直してください。');
    }
    if (!/^[A-Z0-9]{10}$/.test(item.asin ?? '') || !item.condition) throw new LabelError(422, '商品のASINとコンディションを確認してください。');
    const account = accountForLabel(item.sales_channel);
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
    const result = await get('/fba/inventory/v1/summaries', new URLSearchParams({
      granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace, sellerSkus: item.sku,
    }));
    if (!result.ok) throw new LabelError(502, result.status === 403
      ? 'AmazonのFBA在庫へのアクセス権限を確認してください。'
      : 'AmazonからFNSKUを取得できません。時間をおいて再試行してください。');
    const summaries = (await result.json()).payload?.inventorySummaries;
    if (!Array.isArray(summaries)) throw new LabelError(502, 'AmazonのFBA在庫応答が不正です。');
    const {fnsku, title} = exactFbaLabel(summaries, item.sku, item.asin!);
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
    return reply(200, {fnsku, title: title || item.title, condition: item.condition, image});
  } catch (error) {
    return error instanceof LabelError || error instanceof AmazonAccountError ? reply(error.status, {error: error.message})
      : reply(502, {error: '商品ラベル情報を取得できません。時間をおいて再試行してください。'});
  }
}
if (import.meta.main) Deno.serve(handler);
