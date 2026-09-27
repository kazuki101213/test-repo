import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

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
    item_breakdowns: list(t.items).map(item => ({ breakdowns: breakdowns(obj(item).breakdowns) })),
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
    const authorization = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) throw new SafeError(401, 'ログインが必要です。');
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const { data: user, error: authError } = await sb.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (authError || !user.user) throw new SafeError(401, 'ログインが無効です。再ログインしてください。');
    const { data: admin, error: roleError } = await sb.rpc('is_admin');
    if (roleError) throw new SafeError(503, '管理者権限を確認できません。');
    if (admin !== true) throw new SafeError(403, 'ペイメントは管理者のみ利用できます。');
    const body = obj(await req.json().catch(() => null));
    if (body.action !== 'history' && body.action !== 'sync') throw new SafeError(400, '操作の指定が不正です。');
    const range = dateRange(body);
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
