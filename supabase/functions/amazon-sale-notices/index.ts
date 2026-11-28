import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials, type AmazonAccountId } from '../_shared/amazonAccounts.ts';
import { confirmedOrderItems, japanMarketplace } from './orders.ts';

const createService = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false },
});
type Service = ReturnType<typeof createService>;
const endpoint = 'https://sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders';
const minute = 60000;
class OrderPollError extends Error {
  constructor(message: string, public retryAfterMinutes = 5) { super(message); }
}

async function poll(db: Service, account: AmazonAccountId) {
  const { data: claim, error: claimError } = await db.rpc('claim_amazon_sale_poll', { p_account: account });
  if (claimError) throw Error('注文の確認状況を取得できません。');
  if (!claim) return { account, state: 'waiting' };
  try {
    const upper = Date.now() - 3 * minute;
    const previous = Date.parse(claim.through);
    if (!Number.isFinite(previous)) throw new OrderPollError('前回の注文確認時刻が不明です。');
    const credentials = amazonCredentials(account);
    const login = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
        client_id: credentials.clientId, client_secret: credentials.clientSecret }),
      signal: AbortSignal.timeout(12000),
    });
    const auth = await login.json().catch(() => null);
    if (!login.ok || typeof auth?.access_token !== 'string') throw new OrderPollError('Amazonに認証できません。', 60);
    const before = Math.min(upper, previous + 24 * 60 * minute);
    const params = new URLSearchParams({
      marketplaceIds: japanMarketplace, includedData: 'FULFILLMENT,PROCEEDS', maxResultsPerPage: '100',
      lastUpdatedAfter: new Date(Math.min(previous, upper) - 10 * minute).toISOString(),
      lastUpdatedBefore: new Date(before).toISOString(),
    });
    const tokens = new Set<string>();
    let queued = 0;
    let checked = 0;
    do {
      const result = await fetch(endpoint + '?' + params, {
        headers: { 'x-amz-access-token': auth.access_token, 'user-agent': 'BussanAdmin/1.0' },
        signal: AbortSignal.timeout(16000),
      });
      if (!result.ok) throw new OrderPollError(`Amazon注文APIを取得できません（HTTP ${result.status}）。`,
        result.status === 401 || result.status === 403 ? 60 : 5);
      const page = await result.json().catch(() => null);
      if (!Array.isArray(page?.orders)) throw new OrderPollError('Amazonの注文一覧を確認できません。');
      checked += page.orders.length;
      const items = page.orders.flatMap(confirmedOrderItems);
      for (let offset = 0; offset < items.length; offset += 200) {
        const { data, error } = await db.rpc('record_amazon_sale_page', { p_account: account, p_lease: claim.lease,
          p_rows: items.slice(offset, offset + 200) });
        if (error) throw new OrderPollError('Amazonの販売通知を登録できません。');
        queued += data ?? 0;
      }
      const token = page.pagination?.nextToken;
      if (token === undefined || token === null) break;
      if (typeof token !== 'string' || !token || token.length > 10000 || tokens.has(token) || tokens.size >= 6)
        throw new OrderPollError('Amazonの注文一覧を最後まで確認できません。');
      tokens.add(token);
      params.set('paginationToken', token);
    } while (true);
    const { error } = await db.from('amazon_sale_poll').update({ lease_id: null, lease_until: null, next_attempt_at: null,
      checked_through: new Date(Math.max(previous, before)).toISOString(), last_success_at: new Date().toISOString(), last_error: null })
      .eq('account_id', account).eq('lease_id', claim.lease);
    if (error) throw new OrderPollError('注文の確認時刻を保存できません。');
    return { account, state: 'ok', checked, queued };
  } catch (cause) {
    const error = cause instanceof OrderPollError ? cause.message : 'Amazonの注文確認に失敗しました。';
    const retryAfter = cause instanceof OrderPollError ? cause.retryAfterMinutes : 5;
    await db.from('amazon_sale_poll').update({ lease_id: null, lease_until: null, last_error: error,
      next_attempt_at: new Date(Date.now() + retryAfter * minute).toISOString() })
      .eq('account_id', account).eq('lease_id', claim.lease);
    return { account, state: 'error', error };
  }
}

Deno.serve(async req => {
  if (req.method !== 'POST') return Response.json({ error: 'POSTのみ利用できます。' }, { status: 405 });
  const token = req.headers.get('x-amazon-cron-token');
  if (!token) return Response.json({ error: '認証が必要です。' }, { status: 401 });
  const db = createService();
  const check = await db.rpc('verify_amazon_cron_token', { p_token: token });
  if (check.error || check.data !== true) return Response.json({ error: '認証が必要です。' }, { status: 401 });
  const accounts = await Promise.all(amazonAccounts().map(async account => {
    try { return await poll(db, account.id); }
    catch { return { account: account.id, state: 'error', error: '注文確認を開始できません。' }; }
  }));
  return Response.json({ accounts });
});
