// Read-only: reports whether Seller Central listings have photos. Admin only. 2026-11-28
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const mp = 'A1VC38T7YXB528';
const ep = 'https://sellingpartnerapi-fe.amazon.com';
const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' };
const env = (n: string) => Deno.env.get(n)?.trim() ?? '';
Deno.serve(async (req) => {
  const res = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: h });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  try {
    const auth = req.headers.get('authorization') ?? '';
    const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false }, db: { schema: 'app' } });
    const { data: admin } = await sb.rpc('is_admin');
    if (admin !== true) return res(403, { error: '管理者のみ' });
    const body = await req.json();
    const acc = body.accountId === 'amazon-1' ? 'AMAZON_' : body.accountId === 'amazon-2' ? 'AMAZON_2_' : null;
    if (!acc || !Array.isArray(body.skus) || body.skus.length > 25 || !body.skus.every((s: unknown) => typeof s === 'string' && s.length < 100 && !/[,\x00-\x1f]/.test(s))) return res(400, { error: '指定が不正' });
    const lwa = await fetch('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env(acc + 'LWA_CLIENT_ID'), client_secret: env(acc + 'LWA_CLIENT_SECRET'), refresh_token: env(acc + 'LWA_REFRESH_TOKEN') }) });
    if (!lwa.ok) return res(502, { error: 'LWA ' + lwa.status });
    const tok = (await lwa.json()).access_token;
    const seller = env(acc + 'SELLER_ID');
    const rows = [];
    for (const sku of body.skus) {
      const r = await fetch(`${ep}/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(sku)}?marketplaceIds=${mp}&includedData=summaries,attributes`, { headers: { 'x-amz-access-token': tok } });
      if (!r.ok) { rows.push({ sku, http: r.status }); await new Promise(z => setTimeout(z, 250)); continue; }
      const j = await r.json();
      // deno-lint-ignore no-explicit-any
      const s = (j.summaries ?? []).find((x: any) => x.marketplaceId === mp) ?? {};
      const a = j.attributes ?? {};
      const imgKeys = Object.keys(a).filter(k => /image_locator/.test(k));
      rows.push({ sku, asin: s.asin ?? null, status: s.status ?? null, condition: s.conditionType ?? null, mainImage: !!s.mainImage?.link, sellerImages: imgKeys.length, imageKeys: imgKeys, created: s.createdDate ?? null, updated: s.lastUpdatedDate ?? null });
      await new Promise(z => setTimeout(z, 250));
    }
    return res(200, { rows });
  } catch (e) { return res(500, { error: String((e as Error).message).slice(0, 200) }); }
});
