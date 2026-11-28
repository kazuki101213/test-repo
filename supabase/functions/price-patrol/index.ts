// 商品リストの価格巡回（2026-11-29 ユーザー指定）。pg_cron から5分ごとに呼ばれ、少しずつ進める。
//   実績あり：Amazon SP-API（中古「非常に良い」FBAの最安値）／実績無し：Keepaのオファー（直近5件の中央値）
//   差が25%以内なら販売想定金額を書き換え、振込想定金額・仕入れ目標金額も計算し直す。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials, type AmazonAccountId } from '../_shared/amazonAccounts.ts';
import { amazonMarketPrice, decide, keepaMarketPrice, nextTarget, type AmazonOffer, type KeepaOffer } from './logic.ts';

const marketplace = 'A1VC38T7YXB528';
const endpoint = 'https://sellingpartnerapi-fe.amazon.com';
const json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: json });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// deno-lint-ignore no-explicit-any
type Service = SupabaseClient<any, 'app', any>;
type Row = { id: string; asin: string; list_price: number; payout_estimate: number | null; target_cost: number | null; target_profit_rate: number | null };
type Source = 'amazon' | 'keepa';

async function amazonToken(): Promise<{ id: AmazonAccountId; token: string } | null> {
  const accounts = amazonAccounts().filter(a => a.configured).sort((a, b) => Number(b.id === 'amazon-2') - Number(a.id === 'amazon-2'));
  for (const account of accounts) {
    try {
      const c = amazonCredentials(account.id);
      const r = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json().catch(() => null);
      if (r.ok && typeof data?.access_token === 'string') return { id: account.id, token: data.access_token };
    } catch { /* 次のアカウントを試す */ }
  }
  return null;
}

const spHeaders = (token: string) => ({
  'x-amz-access-token': token, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
  'User-Agent': 'BussanPricePatrol/1.0 (Language=TypeScript; Platform=Supabase)', 'Content-Type': 'application/json',
});

/** 登録時・毎日の照合と同じ式：販売価格 − Amazon手数料（FBA）− 500円 */
async function payoutFor(token: string, asin: string, price: number): Promise<number | null> {
  const r = await fetch(`${endpoint}/products/fees/v0/items/${asin}/feesEstimate`, {
    method: 'POST', headers: spHeaders(token), signal: AbortSignal.timeout(9000),
    body: JSON.stringify({ FeesEstimateRequest: {
      MarketplaceId: marketplace, IsAmazonFulfilled: true, Identifier: asin,
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'JPY', Amount: price } },
    } }),
  });
  const body = await r.json().catch(() => null);
  const result = body?.payload?.FeesEstimateResult, fee = result?.FeesEstimate?.TotalFeesEstimate;
  if (!r.ok || result?.Status !== 'Success' || fee?.CurrencyCode !== 'JPY' || typeof fee.Amount !== 'number' || fee.Amount < 0) return null;
  return Math.max(0, Math.floor(price - fee.Amount - 500));
}

async function settle(service: Service, token: string | null, row: Row, source: Source, market: number | null, detail: Record<string, unknown>) {
  const verdict = decide(row.list_price, market);
  let outcome: string = verdict.outcome, error: string | null = null;
  if (verdict.apply && market !== null) {
    const payout = token ? await payoutFor(token, row.asin, market).catch(() => null) : null;
    if (payout === null || payout > market) {
      outcome = '手数料の見積もり失敗（反映しない）'; error = 'Amazonの手数料見積もりが返りませんでした';
    } else {
      const target = nextTarget(row.payout_estimate, row.target_cost, row.target_profit_rate, payout);
      const { data: saved, error: e } = await service.rpc('price_patrol_apply', {
        p_product_id: row.id, p_source: source, p_old_price: row.list_price, p_new_price: market,
        p_old_payout: row.payout_estimate, p_new_payout: payout, p_old_target: row.target_cost, p_new_target: target,
        p_detail: { ...detail, gap: 'gap' in verdict ? verdict.gap : null },
      });
      if (e || saved !== true) { outcome = '書き換えなし（途中で値が変わった）'; error = e?.message ?? null; }
    }
  }
  await service.rpc('price_patrol_record', {
    p_product_id: row.id, p_source: source, p_market: market, p_outcome: outcome, p_detail: detail, p_error: error,
  });
  return outcome;
}

async function amazonRound(service: Service, started: number, auth: { token: string } | null, tally: Record<string, number>) {
  const { data, error } = await service.rpc('price_patrol_due', { p_source: 'amazon', p_limit: 20 });
  if (error) throw new Error('実績ありの商品を読み込めませんでした');
  const rows = (data ?? []) as Row[];
  if (!rows.length || !auth || Date.now() - started > 60_000) return;
  const r = await fetch(`${endpoint}/batches/products/pricing/v0/itemOffers`, {
    method: 'POST', headers: spHeaders(auth.token), signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ requests: rows.map(row => ({
      uri: `/products/pricing/v0/items/${row.asin}/offers`, method: 'GET',
      MarketplaceId: marketplace, ItemCondition: 'Used', CustomerType: 'Consumer',
    })) }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(body?.responses)) { tally['Amazon価格APIの失敗'] = (tally['Amazon価格APIの失敗'] ?? 0) + 1; return; }
  for (const [i, row] of rows.entries()) {
    const res = body.responses[i];
    if (res?.status?.statusCode !== 200) {
      await service.rpc('price_patrol_record', { p_product_id: row.id, p_source: 'amazon', p_market: null, p_outcome: '取得失敗',
        p_detail: null, p_error: String(res?.body?.errors?.[0]?.message ?? res?.status?.statusCode ?? '不明') });
      tally['取得失敗'] = (tally['取得失敗'] ?? 0) + 1; continue;
    }
    const offers = (res.body?.payload?.Offers ?? []) as AmazonOffer[];
    const { price, count } = amazonMarketPrice(offers);
    const outcome = await settle(service, auth.token, row, 'amazon', price, { fbaVeryGood: count, offers: offers.length });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    if (outcome === '値上げ' || outcome === '値下げ') await sleep(1100); // 手数料APIの間隔
  }
}

async function keepaRound(service: Service, started: number, auth: { token: string } | null, tally: Record<string, number>) {
  const { data: key } = await service.rpc('price_patrol_keepa_key');
  if (typeof key !== 'string' || !key) { tally['Keepaキーなし'] = 1; return; }
  for (let n = 0; n < 4 && Date.now() - started < 100_000; n++) {
    const { data, error } = await service.rpc('price_patrol_due', { p_source: 'keepa', p_limit: 1 });
    if (error) throw new Error('実績無しの商品を読み込めませんでした');
    const row = ((data ?? []) as Row[])[0];
    if (!row) return;
    const params = new URLSearchParams({ key, domain: '5', asin: row.asin, offers: '20', 'only-live-offers': '0', history: '0' });
    const r = await fetch('https://api.keepa.com/product?' + params, { signal: AbortSignal.timeout(45000) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 429 || !body?.products) { tally['Keepaトークン待ち'] = (tally['Keepaトークン待ち'] ?? 0) + 1; return; }
    const offers = (body.products[0]?.offers ?? []) as KeepaOffer[];
    const { price, prices } = keepaMarketPrice(offers, Date.now());
    const outcome = await settle(service, auth?.token ?? null, row, 'keepa', price, { prices, tokens: body.tokensConsumed });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    if (typeof body.tokensLeft === 'number' && body.tokensLeft < 14) return; // 次の1件分が無ければ次の回へ
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return respond(405, { error: 'POSTのみ' });
  const token = req.headers.get('x-amazon-cron-token') ?? '';
  if (!/^[0-9a-f]{64}$/.test(token)) return respond(401, { error: '定期実行の認証が必要です' });
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
  }) as Service;
  const { data: verified, error } = await service.rpc('verify_amazon_cron_token', { p_token: token });
  if (error || verified !== true) return respond(401, { error: '定期実行の認証に失敗しました' });
  const input = await req.json().catch(() => ({}));
  const started = Date.now(), tally: Record<string, number> = {};
  try {
    const auth = await amazonToken();
    if (input?.only !== 'keepa') await amazonRound(service, started, auth, tally);
    if (input?.only !== 'amazon') await keepaRound(service, started, auth, tally);
    return respond(200, { tally, ms: Date.now() - started });
  } catch (e) {
    return respond(503, { error: e instanceof Error ? e.message : '巡回に失敗しました', tally });
  }
}

if (import.meta.main) Deno.serve(handler);
