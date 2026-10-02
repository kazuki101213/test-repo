import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { candidates } from './reconcile.ts';

const marketplace = 'A1VC38T7YXB528';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
class SafeError extends Error { constructor(public status: number, message: string) { super(message); } }
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown, max = 500): string | null => typeof v === 'string' ? v.slice(0, max) : null;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const amount = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
type Breakdown = { label: string | null; amount: number | null; currency: string | null; children: Breakdown[] };
function breakdowns(v: unknown, depth = 0): Breakdown[] {
  if (depth > 8) throw new SafeError(502, 'Amazonの金額内訳が深すぎるため保存を中止しました。');
  return list(v).map(entry => { const b = obj(entry), a = obj(b.breakdownAmount); return { label: str(b.breakdownType), amount: amount(a.currencyAmount), currency: str(a.currencyCode, 3), children: breakdowns(b.breakdowns, depth + 1) }; });
}
export function normalizeTransaction(value: unknown, accountKey: string, fetchedAt: string) {
  const t = obj(value), a = obj(t.totalAmount);
  // Fail the entire page rather than silently losing financial records.
  if (typeof t.transactionId !== 'string' || !t.transactionId || t.transactionId.length > 500 || typeof t.postedDate !== 'string' || !Number.isFinite(Date.parse(t.postedDate))) throw new SafeError(502, 'Amazonの取引IDまたは日時が不正なため、このページは保存していません。');
  const market = obj(t.marketplaceDetails).marketplaceId;
  if (market && market !== marketplace) throw new SafeError(502, '対象外マーケットプレイスの応答のため保存を中止しました。');
  const payment = list(t.contexts).map(obj).find(c => c.contextType === 'PaymentsContext');
  return {
    account_key: accountKey, marketplace_id: marketplace, transaction_id: t.transactionId,
    posted_at: new Date(t.postedDate).toISOString(), transaction_type: str(t.transactionType), status: str(t.transactionStatus),
    description: str(t.description, 2000), amount: amount(a.currencyAmount), currency: str(a.currencyCode, 3),
    order_id: str(list(t.relatedIdentifiers).map(obj).find(i => i.relatedIdentifierName === 'ORDER_ID')?.relatedIdentifierValue),
    payment_date: typeof payment?.paymentDate === 'string' && Number.isFinite(Date.parse(payment.paymentDate)) ? new Date(payment.paymentDate).toISOString() : null,
    breakdowns: breakdowns(t.breakdowns),
    item_breakdowns: list(t.items).map(item => {
      const entry = obj(item), product = list(entry.contexts).map(obj).find(c => c.contextType === 'ProductContext');
      const total = obj(entry.totalAmount);
      return { breakdowns: breakdowns(entry.breakdowns), sku: str(product?.sku), asin: str(product?.asin, 20),
        quantity: amount(product?.quantityShipped), amount: amount(total.currencyAmount), currency: str(total.currencyCode, 3) };
    }),
    fetched_at: fetchedAt,
  };
}
export function dateRange(body: Obj, now = Date.now()) {
  if (typeof body.postedAfter !== 'string' || typeof body.postedBefore !== 'string') throw new SafeError(400, '取得期間を指定してください。');
  const after = Date.parse(body.postedAfter), before = Date.parse(body.postedBefore);
  if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after || before - after > 180 * 86400000 || before > now - 120000) throw new SafeError(400, '期間は180日以内、終了は現在より2分以上前で指定してください。');
  return { postedAfter: new Date(after).toISOString(), postedBefore: new Date(before).toISOString() };
}

export async function handler(req: Request): Promise<Response> {
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return respond(405, { error: 'POSTのみ利用できます。' });
  try {
    const body = obj(await req.json().catch(() => null));
    const cronToken = req.headers.get('x-amazon-cron-token');
    const scheduled = cronToken !== null;
    const authorization = req.headers.get('authorization') ?? '';
    const sb = scheduled
      ? createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' } })
      : createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
      });
    let actorId: string;
    if (scheduled) {
      const { data: authorized, error: cronError } = await sb.rpc('verify_amazon_cron_token', { p_token: cronToken });
      if (cronError || authorized !== true) throw new SafeError(401, '定期更新の認証に失敗しました。');
      const { data: adminStaff, error: staffError } = await sb.from('staff').select('id').eq('role', 'admin').eq('is_active', true).limit(1).maybeSingle();
      if (staffError || !adminStaff) throw new SafeError(503, '管理者を確認できません。');
      const { data: adminProfile, error: profileError } = await sb.from('profiles').select('user_id').eq('staff_id', adminStaff.id).limit(1).maybeSingle();
      if (profileError || !adminProfile) throw new SafeError(503, '管理者の利用者情報を確認できません。');
      actorId = adminProfile.user_id;
    } else {
      if (!/^Bearer\s+\S+$/i.test(authorization)) throw new SafeError(401, 'ログインが必要です。');
      const { data: user, error: authError } = await sb.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
      if (authError || !user.user) throw new SafeError(401, 'ログインが無効です。再ログインしてください。');
      const { data: admin, error: roleError } = await sb.rpc('is_admin');
      if (roleError) throw new SafeError(503, '管理者権限を確認できません。');
      if (admin !== true) throw new SafeError(403, 'ペイメントは管理者のみ利用できます。');
      actorId = user.user.id;
    }
    if (!['history', 'sync', 'reconcile', 'daily', 'diagnose'].includes(String(body.action))) throw new SafeError(400, '操作の指定が不正です。');
    if (body.action === 'daily') {
      if (!scheduled) throw new SafeError(403, '定期更新からのみ実行できます。');
      const now = Date.now();
      const range = { postedAfter: new Date(now - 7 * 86400000).toISOString(), postedBefore: new Date(now - 180000).toISOString() };
      const call = async (action: string, extra: Obj = {}) => {
        const response = await handler(new Request(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amazon-cron-token': cronToken! }, body: JSON.stringify({ action, ...range, ...extra }) }));
        const result = await response.json();
        if (!response.ok) throw new SafeError(response.status, result.error || '定期更新に失敗しました。');
        return result;
      };
      let nextToken: string | undefined, saved = 0, applied = 0, reviewed = 0, processed = 0;
      const seen = new Set<string>();
      do {
        const page = await call('sync', nextToken ? { nextToken } : {});
        saved += page.saved;
        nextToken = page.nextToken;
        if (nextToken && seen.has(nextToken)) throw new SafeError(502, 'Amazonのページ情報が重複しました。');
        if (nextToken) { seen.add(nextToken); await new Promise(resolve => setTimeout(resolve, 2100)); }
      } while (nextToken);
      let offset = 0, more = true;
      while (more) {
        const history = await call('history', { offset });
        more = history.hasMore; offset += 100;
        for (const row of history.rows as { transaction_id: string }[]) {
          const match = await call('reconcile', { transactionId: row.transaction_id });
          processed++;
          for (const result of match.results as { status: string }[]) {
            if (result.status === 'applied') applied++;
            if (result.status === 'review') reviewed++;
          }
          await new Promise(resolve => setTimeout(resolve, 2100));
        }
      }
      return respond(200, { saved, processed, applied, reviewed });
    }
    if (body.action === 'diagnose' && !scheduled) throw new SafeError(403, '診断は定期更新の認証からのみ実行できます。');
    const range = body.action === 'diagnose'
      ? { postedAfter: new Date(Date.now() - 4 * 86400000).toISOString(), postedBefore: new Date(Date.now() - 180000).toISOString() }
      : dateRange(body);
    const seller = Deno.env.get('AMAZON_SELLER_ID')?.trim();
    if (!seller) throw new SafeError(503, 'AMAZON_SELLER_IDが未設定です。');
    // Separate histories by seller without persisting the credential itself.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seller));
    const accountKey = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    if (body.action === 'history') {
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1000000) throw new SafeError(400, '履歴のページ指定が不正です。');
      const { data, error } = await sb.from('amazon_payment_transactions')
        .select('transaction_id,posted_at,transaction_type,status,description,amount,currency,order_id,payment_date,breakdowns,item_breakdowns,fetched_at')
        .eq('account_key', accountKey).eq('marketplace_id', marketplace).gte('posted_at', range.postedAfter).lt('posted_at', range.postedBefore)
        .order('posted_at', { ascending: false }).order('transaction_id').range(Number(offset), Number(offset) + 100);
      if (error) throw new SafeError(503, '保存済み履歴を読み込めません。保存先の設定を確認してください。');
      return respond(200, { rows: data.slice(0, 100), hasMore: data.length > 100 });
    }
    if (body.nextToken !== undefined && (typeof body.nextToken !== 'string' || !body.nextToken || body.nextToken.length > 10000)) throw new SafeError(400, 'ページ指定が不正です。');
    const names = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN'] as const;
    const missing = names.filter(name => !Deno.env.get(name)?.trim());
    if (missing.length) throw new SafeError(503, `Supabase Secretsが未設定です: ${missing.join(', ')}`);
    const lwa = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: Deno.env.get(names[0])!, client_secret: Deno.env.get(names[1])!, refresh_token: Deno.env.get(names[2])! }),
    });
    if (!lwa.ok) {
      const failure = await lwa.json().catch(() => null);
      const hint = failure?.error === 'invalid_client' ? 'Client IDとClient Secretを確認してください。' : failure?.error === 'invalid_grant' ? 'アプリを再認可しRefresh Tokenを更新してください。' : 'Amazon認証設定を確認してください。';
      throw new SafeError(502, `Amazon LWA認証エラー（HTTP ${lwa.status}）。${hint}`);
    }
    const token = await lwa.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new SafeError(502, 'Amazon LWAの応答が不正です。');
    if (body.action === 'diagnose') {
      const commonHeaders = { 'x-amz-access-token': token.access_token, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), 'user-agent': 'BussanAdmin/1.0 (Language=TypeScript; Platform=Supabase)' };
      const sellerResponse = await fetch('https://sellingpartnerapi-fe.amazon.com/sellers/v1/marketplaceParticipations', { headers: commonHeaders, signal: AbortSignal.timeout(20000) });
      const sellerBody = await sellerResponse.json().catch(() => null);
      const otherRegions = await Promise.all(['na', 'eu'].map(async region => {
        const response = await fetch(`https://sellingpartnerapi-${region}.amazon.com/sellers/v1/marketplaceParticipations`, { headers: commonHeaders, signal: AbortSignal.timeout(20000) });
        const payload = await response.json().catch(() => null);
        return { region, status: response.status, code: str(list(obj(payload).errors).map(obj)[0]?.code, 80) };
      }));
      const financeParams = new URLSearchParams({ ...range, marketplaceId: marketplace });
      const financeResponse = await fetch(`https://sellingpartnerapi-fe.amazon.com/finances/2024-06-19/transactions?${financeParams}`, { headers: commonHeaders, signal: AbortSignal.timeout(20000) });
      const financeBody = await financeResponse.json().catch(() => null);
      const [inventoryResponse, financeLegacyResponse] = await Promise.all([
        fetch(`https://sellingpartnerapi-fe.amazon.com/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${encodeURIComponent(marketplace)}&marketplaceIds=${encodeURIComponent(marketplace)}`, { headers: commonHeaders, signal: AbortSignal.timeout(20000) }),
        fetch('https://sellingpartnerapi-fe.amazon.com/finances/v0/financialEventGroups?MaxResultsPerPage=1', { headers: commonHeaders, signal: AbortSignal.timeout(20000) }),
      ]);
      const inventoryBody = await inventoryResponse.json().catch(() => null);
      const financeLegacyBody = await financeLegacyResponse.json().catch(() => null);
      const detailClass = (body: unknown) => {
        const detail = str(list(obj(body).errors).map(obj)[0]?.details, 500);
        if (detail === 'The LWA secret token you provided has expired.') return 'client_secret_expired';
        if (detail === 'Access token is missing in the request header.') return 'access_token_missing';
        if (detail === 'The access token you provided has expired.') return 'access_token_expired';
        return detail ? 'other_detail' : 'no_detail';
      };
      return respond(200, {
        lwa: 'ok', sellerStatus: sellerResponse.status, financeStatus: financeResponse.status, otherRegions,
        inventoryStatus: inventoryResponse.status, financeLegacyStatus: financeLegacyResponse.status,
        sellerRequestId: str(sellerResponse.headers.get('x-amzn-requestid'), 100),
        financeRequestId: str(financeResponse.headers.get('x-amzn-requestid'), 100),
        inventoryRequestId: str(inventoryResponse.headers.get('x-amzn-requestid'), 100),
        financeLegacyRequestId: str(financeLegacyResponse.headers.get('x-amzn-requestid'), 100),
        sellerMessage: str(list(obj(sellerBody).errors).map(obj)[0]?.message, 200),
        financeMessage: str(list(obj(financeBody).errors).map(obj)[0]?.message, 200),
        inventoryMessage: str(list(obj(inventoryBody).errors).map(obj)[0]?.message, 200),
        financeLegacyMessage: str(list(obj(financeLegacyBody).errors).map(obj)[0]?.message, 200),
        jpMarketplace: list(obj(sellerBody).payload).some(p => obj(obj(p).marketplace).id === marketplace),
        sellerCode: str(list(obj(sellerBody).errors).map(obj)[0]?.code, 80),
        financeCode: str(list(obj(financeBody).errors).map(obj)[0]?.code, 80),
        sellerDetail: detailClass(sellerBody), financeDetail: detailClass(financeBody),
      });
    }
    if (body.action === 'reconcile') {
      if (typeof body.transactionId !== 'string' || !body.transactionId || body.transactionId.length > 500) throw new SafeError(400, '取引IDを指定してください。');
      const { data: transaction, error: readError } = await sb.from('amazon_payment_transactions').select('*')
        .eq('account_key', accountKey).eq('marketplace_id', marketplace).eq('transaction_id', body.transactionId).maybeSingle();
      if (readError) throw new SafeError(503, '照合する履歴を読み込めません。');
      if (!transaction) throw new SafeError(404, '先にAmazonの販売情報を取得してください。');
      const normalizedType = String(transaction.transaction_type ?? '').toLowerCase();
      const isInventoryReimbursement = ['inventory reimbursement', 'inventoryreimbursement', 'fba inventory reimbursement', 'fbainventoryreimbursement', 'fba_inventory_reimbursement'].includes(normalizedType);
      if (isInventoryReimbursement || normalizedType === 'refund') {
        if (!['RELEASED', 'DEFERRED_RELEASED'].includes(String(transaction.status))) {
          return respond(200, { results: [{ sku: '—', status: 'review', reason: '金額が確定していない取引のため反映しません。' }] });
        }
        const writer = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } });
        const skus = [...new Set(list(transaction.item_breakdowns).map(obj).map(item => item.sku).filter((sku): sku is string => typeof sku === 'string' && sku.length > 0))];
        if (!skus.length) return respond(200, { results: [{ sku: '—', status: 'review', reason: '取引にSKU別の金額情報がありません。' }] });
        const results = [];
        for (const sku of skus) {
          const { data: result, error } = await writer.rpc('apply_amazon_refund', {
            p_account: accountKey, p_transaction: transaction.transaction_id, p_sku: sku, p_actor: actorId,
          });
          if (error) throw new SafeError(503, 'Amazonの返金情報を在庫へ反映できませんでした。再照合できます。');
          results.push({ sku, ...result });
        }
        return respond(200, { results });
      }
      if (transaction.transaction_type !== 'Shipment' || transaction.status !== 'RELEASED') {
        return respond(200, { results: candidates(transaction, null).results });
      }
      if (typeof transaction.order_id !== 'string' || !/^\d{3}-\d{7}-\d{7}$/.test(transaction.order_id)) {
        return respond(200, { results: [{ sku: '—', status: 'review', reason: 'Amazon注文IDがありません。' }] });
      }
      // Only request non-PII product/order data. Financial posting dates are NOT sale dates.
      const response = await fetch(`https://sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders/${encodeURIComponent(transaction.order_id)}?includedData=PROCEEDS`, {
        headers: { 'x-amz-access-token': token.access_token, 'user-agent': 'BussanAdmin/1.0' }, signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new SafeError(502, `Amazon注文情報の取得エラー（HTTP ${response.status}）。注文情報の取得権限・アプリ認可を確認してください。販売日は推測して登録していません。`);
      const data = await response.json();
      const { sales, results } = candidates(transaction, data.order);
      const writer = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } });
      for (const sale of sales) {
        const { data: result, error } = await writer.rpc('apply_amazon_sale', {
          p_account: accountKey, p_transaction: transaction.transaction_id, p_sku: sale.sku, p_asin: sale.asin,
          p_sold_on: sale.soldOn, p_price: sale.price, p_payout: sale.payout, p_actor: actorId,
        });
        if (error) throw new SafeError(503, '在庫への反映に失敗しました。途中まで反映された分は重複せず、再実行できます。');
        results.push({ sku: sale.sku, ...result });
      }
      return respond(200, { results });
    }
    const params = new URLSearchParams({ ...range, marketplaceId: marketplace });
    if (body.nextToken) params.set('nextToken', String(body.nextToken));
    const response = await fetch(`https://sellingpartnerapi-fe.amazon.com/finances/2024-06-19/transactions?${params}`, {
      headers: { 'x-amz-access-token': token.access_token, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), 'user-agent': 'BussanAdmin/1.0 (Language=TypeScript; Platform=Supabase)' }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null), code = failure?.errors?.[0]?.code;
      const safeCode = ['Unauthorized', 'AccessDenied', 'InvalidInput', 'QuotaExceeded'].includes(code) ? ` / ${code}` : '';
      const id = response.headers.get('x-amzn-requestid') ?? '';
      const reference = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? ` 問い合わせID: ${id}` : '';
      const hint = response.status === 403 ? '出品者用「財務会計」ロールと、ロール追加後のアプリ再認可を確認してください。' : response.status === 429 ? '取得制限です。時間をおいて再試行してください。' : 'Amazonの設定・稼働状況を確認してください。';
      throw new SafeError(502, `Amazon Finances APIエラー（HTTP ${response.status}${safeCode}）。${hint}${reference}`);
    }
    const responseBody = await response.json();
    if (!responseBody?.payload || (responseBody.payload.transactions != null && !Array.isArray(responseBody.payload.transactions))) throw new SafeError(502, 'Amazon Financesの応答が不正です。');
    const nextToken = responseBody.payload.nextToken;
    if (nextToken != null && (typeof nextToken !== 'string' || nextToken.length > 10000)) throw new SafeError(502, 'Amazonのページ情報が不正です。');
    const fetchedAt = new Date().toISOString();
    const records = list(responseBody.payload.transactions).map(t => normalizeTransaction(t, accountKey, fetchedAt));
    const unique = [...new Map(records.map(r => [r.transaction_id, r])).values()];
    if (unique.length) {
      // Only the authenticated administrator can reach this trusted write path.
      const writer = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await writer.from('amazon_payment_transactions').upsert(unique, { onConflict: 'account_key,marketplace_id,transaction_id' });
      if (error) throw new SafeError(503, 'Amazonから取得できましたが、履歴の保存に失敗しました。同じ期間で再試行できます。');
    }
    return respond(200, { saved: unique.length, nextToken: nextToken || undefined, fetchedAt, ...range });
  } catch (e) {
    return respond(e instanceof SafeError ? e.status : 502, { error: e instanceof SafeError ? e.message : '外部サービスとの通信に失敗しました。時間をおいて再試行してください。' });
  }
}
if (import.meta.main) Deno.serve(handler);
