import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const marketplace = 'A1VC38T7YXB528';
const endpoint = 'https://sellingpartnerapi-fe.amazon.com';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
class SafeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Inventory = { sellerSku: string; asin: string; productName: string; totalQuantity: number; inventoryDetails?: { fulfillableQuantity?: number; reservedQuantity?: { totalReservedQuantity?: number } } };
type Listing = { sku: string; summaries?: { marketplaceId: string; status?: string[] }[] };

export async function handler(req: Request): Promise<Response> {
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond(405, { error: 'POSTのみ利用できます。' });
  try {
    const authorization = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) throw new SafeError(401, 'ログインが必要です。');
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const { data: user, error: authError } = await sb.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (authError || !user.user) throw new SafeError(401, 'ログインが無効です。再ログインしてください。');
    const { data: admin, error: roleError } = await sb.rpc('is_admin');
    if (roleError) throw new SafeError(503, '管理者権限を確認できません。Supabaseのappスキーマ設定を確認してください。');
    if (admin !== true) throw new SafeError(403, '有効な管理者アカウントのみ利用できます。');
    const body = await req.json().catch(() => { throw new SafeError(400, 'リクエストの形式が不正です。'); });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SafeError(400, 'リクエストの形式が不正です。');
    const nextToken = body.nextToken;
    if (nextToken !== undefined && (typeof nextToken !== 'string' || nextToken.length > 10000)) throw new SafeError(400, 'ページ指定が不正です。');
    const names = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN', 'AMAZON_SELLER_ID'] as const;
    const missing = names.filter(name => !Deno.env.get(name)?.trim());
    if (missing.length) throw new SafeError(503, `Supabase Edge Function Secretsが未設定です: ${missing.join(', ')}`);
    const lwa = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: Deno.env.get(names[0])!, client_secret: Deno.env.get(names[1])!, refresh_token: Deno.env.get(names[2])! }),
    });
    if (!lwa.ok) throw new SafeError(502, `Amazon LWA認証に失敗しました（HTTP ${lwa.status}）。Client ID・Secret・Refresh Tokenを確認してください。`);
    const token = await lwa.json();
    if (typeof token.access_token !== 'string') throw new SafeError(502, 'Amazon LWAの応答が不正です。');
    async function get(path: string, params: URLSearchParams) {
      const response = await fetch(`${endpoint}${path}?${params}`, { headers: { 'x-amz-access-token': token.access_token }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        const hint = response.status === 403 ? 'Product Listingロール・アプリ認可・Seller IDを確認してください。' : response.status === 429 ? 'Amazonの取得制限です。時間をおいて再試行してください。' : 'Amazonの設定・稼働状況を確認してください。';
        throw new SafeError(502, `Amazon ${path.startsWith('/fba') ? 'FBA Inventory' : 'Listings Items'} APIエラー（HTTP ${response.status}）。${hint}`);
      }
      return response.json();
    }
    const params = new URLSearchParams({ granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace, details: 'true' });
    if (nextToken) params.set('nextToken', nextToken);
    const inventory = await get('/fba/inventory/v1/summaries', params);
    const summaries: Inventory[] = inventory.payload?.inventorySummaries;
    if (!Array.isArray(summaries)) throw new SafeError(502, 'FBA Inventoryの応答が不正です。');
    const statuses = new Map<string, string[]>();
    const skus = [...new Set(summaries.map(item => item.sellerSku))];
    if (skus.some(sku => sku.includes(','))) throw new SafeError(422, 'カンマを含むSKUは出品状態の一括検索に対応していません。');
    for (let offset = 0; offset < skus.length; offset += 20) {
      const listingParams = new URLSearchParams({ marketplaceIds: marketplace, identifiersType: 'SKU', identifiers: skus.slice(offset, offset + 20).join(','), includedData: 'summaries', pageSize: '20' });
      let pageCount = 0;
      do {
        const listings = await get(`/listings/2021-08-01/items/${encodeURIComponent(Deno.env.get(names[3])!)}`, listingParams);
        if (!Array.isArray(listings.items)) throw new SafeError(502, 'Listings Itemsの応答が不正です。');
        for (const item of listings.items as Listing[]) {
          const summary = item.summaries?.find(s => s.marketplaceId === marketplace);
          if (summary?.status) statuses.set(item.sku, summary.status);
        }
        const pageToken = listings.pagination?.nextToken;
        if (!pageToken) break;
        if (++pageCount >= 10) throw new SafeError(502, '出品状態のページ数が上限を超えました。');
        listingParams.set('pageToken', pageToken);
      } while (true);
    }
    return respond(200, {
      rows: summaries.map(item => ({ sku: item.sellerSku, asin: item.asin, name: item.productName, total: item.totalQuantity,
        fulfillable: item.inventoryDetails?.fulfillableQuantity ?? null, reserved: item.inventoryDetails?.reservedQuantity?.totalReservedQuantity ?? null, status: statuses.get(item.sellerSku) ?? null })),
      nextToken: inventory.pagination?.nextToken, fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Never echo upstream payloads, request headers, tokens, or raw exceptions.
    return respond(error instanceof SafeError ? error.status : 502, { error: error instanceof SafeError ? error.message : '外部サービスとの通信に失敗しました。時間をおいて再試行してください。' });
  }
}
if (import.meta.main) Deno.serve(handler);
