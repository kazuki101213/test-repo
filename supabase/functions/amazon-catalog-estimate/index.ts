import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials, type AmazonAccountId } from '../_shared/amazonAccounts.ts';

const marketplace = 'A1VC38T7YXB528';
const endpoint = 'https://sellingpartnerapi-fe.amazon.com';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
type Listing = { sku: string; sales_channel: string; account_id: AmazonAccountId; item_id: string };
type Inventory = { id: string; sales_channel: string };
type FeeResponse = { payload?: { FeesEstimateResult?: {
  Status?: string;
  FeesEstimate?: { TotalFeesEstimate?: { Amount?: number; CurrencyCode?: string } };
} } };

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function pickFulfillment(items: Inventory[], listings: Listing[]) {
  const methods = new Set(items.map(item => item.sales_channel.startsWith('FBA') ? 'fba' : 'mfn'));
  const fba = methods.size !== 1 || methods.has('fba');
  const known = listings.find(listing => items.some(item =>
    item.id === listing.item_id && item.sales_channel === listing.sales_channel
    && listing.sales_channel.startsWith(fba ? 'FBA' : '自己発送')));
  const channel = known?.sales_channel ?? items.find(item => item.sales_channel.startsWith(fba ? 'FBA' : '自己発送'))?.sales_channel;
  const preferred = known?.account_id ?? (channel?.endsWith('1') ? 'amazon-1' : 'amazon-2');
  return { fba, sku: known?.sku, preferred } as const;
}

export function estimatePayout(price: number, body: FeeResponse): number | null {
  const result = body?.payload?.FeesEstimateResult;
  const fee = result?.FeesEstimate?.TotalFeesEstimate;
  if (result?.Status !== 'Success' || fee?.CurrencyCode !== 'JPY' || typeof fee.Amount !== 'number'
    || !Number.isFinite(fee.Amount) || fee.Amount < 0) return null;
  return Math.max(0, Math.floor(price - fee.Amount - 500));
}

async function getToken(account: AmazonAccountId) {
  const credentials = amazonCredentials(account);
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data?.access_token === 'string' ? data.access_token as string : null;
}

async function quote(token: string, asin: string, sku: string | undefined, price: number, fba: boolean) {
  const target = sku ? 'listings/' + encodeURIComponent(sku) : 'items/' + asin;
  const response = await fetch(endpoint + '/products/fees/v0/' + target + '/feesEstimate', {
    method: 'POST',
    headers: {
      'x-amz-access-token': token,
      'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
      'User-Agent': 'BussanCatalog/1.0 (Language=TypeScript; Platform=Supabase)',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ FeesEstimateRequest: {
      MarketplaceId: marketplace,
      IsAmazonFulfilled: fba,
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'JPY', Amount: price } },
      Identifier: asin,
    } }),
    signal: AbortSignal.timeout(8500),
  });
  return response.ok ? estimatePayout(price, await response.json()) : null;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond(405, { error: 'POSTを使用してください。' });
  const authorization = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (!token) return respond(401, { error: '管理アプリにログインしてください。' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const auth = { persistSession: false, autoRefreshToken: false };
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth, db: { schema: 'app' }, global: { headers: { Authorization: authorization } },
    });
    const { data: user, error: loginError } = await caller.auth.getUser(token);
    if (loginError || !user.user) return respond(401, { error: '管理アプリにログインしてください。' });
    const { data: role, error: roleError } = await caller.rpc('current_role');
    if (roleError || !['admin', 'purchaser'].includes(role)) {
      return respond(403, { error: '商品リストを登録できるアカウントでログインしてください。' });
    }

    const input = await req.json().catch(() => null);
    const { asin, price } = input ?? {};
    if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin) || !Number.isSafeInteger(price)
      || price < 1 || price > 2147483647) {
      return respond(400, { error: 'ASINと販売想定金額を確認してください。' });
    }
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth, db: { schema: 'app' } });
    const [inventory, submissions, accountState] = await Promise.all([
      service.from('items').select('id,sales_channel').eq('asin', asin)
        .in('sales_channel', ['FBA','FBA1','FBA2','自己発送','自己発送1','自己発送2'])
        .in('status', ['出品中','取引中']).is('sold_on', null).limit(100),
      service.from('amazon_listing_submissions').select('item_id,sku,sales_channel,account_id')
        .eq('asin', asin).eq('state', 'verified').order('verified_at', { ascending: false }).limit(30),
      service.from('amazon_seller_inventory_sync').select('account_id,account_suspended'),
    ]);
    if (inventory.error || submissions.error || accountState.error) return respond(503, { error: 'Amazon出品情報を確認できませんでした。' });
    const { fba, sku, preferred } = pickFulfillment((inventory.data ?? []) as Inventory[], (submissions.data ?? []) as Listing[]);
    const suspended = new Set((accountState.data ?? []).filter(row => row.account_suspended).map(row => row.account_id));
    const accounts = amazonAccounts().filter(account => account.configured && !suspended.has(account.id))
      .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    for (const account of accounts) {
      try {
        const access = await getToken(account.id);
        if (!access) continue;
        const knownSku = account.id === preferred ? sku : undefined;
        const payout = knownSku ? await quote(access, asin, knownSku, price, fba) : null;
        const amount = payout ?? await quote(access, asin, undefined, price, fba);
        if (amount !== null) return respond(200, { payout: amount });
      } catch {
        // An unavailable account must not prevent an ASIN estimate on the other account.
      }
    }
    return respond(502, { error: 'Amazonの手数料見積もりを取得できませんでした。時間をおいて登録してください。' });
  } catch {
    return respond(503, { error: 'Amazonの手数料見積もりを確認できませんでした。' });
  }
}
if (import.meta.main) Deno.serve(handler);
