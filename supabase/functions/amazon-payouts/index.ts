// Amazonの振込（振込グループ）を定期的に取り込む。定期更新の認証からのみ動く。
// Amazonへは読み取りのみ。失敗しても他のAmazon連携（売上・返品など）には影響しない。
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials } from '../_shared/amazonAccounts.ts';
import { fetchPayoutGroups, type PayoutGroup } from './payouts.ts';

const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function database() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false },
  });
}

// amazon-payments と同じ方法で出品者ごとの保存キーを作る（出品者IDそのものは保存しない）。
async function sellerAccountKey(sellerId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sellerId));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function accessToken(credentials: ReturnType<typeof amazonCredentials>): Promise<string> {
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
      client_id: credentials.clientId, client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || typeof value?.access_token !== 'string') throw new Error('Amazonの認証に失敗しました');
  return value.access_token;
}

// 最新の振込が締まった後の明細がまだ保存されていなければ、その期間の明細だけを
// amazon-payments の取得処理で保存し直す（内訳と振込額をそろえるため）。
export function latestClosedGroup(groups: PayoutGroup[]) {
  return groups.filter(group => group.processing_status === 'Closed' && group.group_start && group.group_end)
    .sort((a, b) => Date.parse(b.group_end!) - Date.parse(a.group_end!))[0];
}

async function refreshLatestPayoutHistory(db: ReturnType<typeof database>, token: string, accountId: string, accountKey: string, groups: PayoutGroup[]) {
  const latest = latestClosedGroup(groups);
  if (!latest) return { skipped: 'no closed payout' };
  const { count, error } = await db.from('amazon_payment_transactions').select('transaction_id', { count: 'exact', head: true })
    .eq('account_key', accountKey).gt('fetched_at', latest.group_end!);
  if (error) throw new Error('保存済みの明細を確認できません');
  if (count) return { skipped: 'already fetched' };
  const end = Math.min(Date.parse(latest.group_end!) + 60000, Date.now() - 180000);
  const start = Math.max(Date.parse(latest.group_start!), end - 179 * 86400000);
  let nextToken: string | undefined, saved = 0;
  for (let page = 0; page < 30; page++) {
    const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/amazon-payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amazon-cron-token': token },
      body: JSON.stringify({ action: 'sync', accountId, postedAfter: new Date(start).toISOString(), postedBefore: new Date(end).toISOString(), ...(nextToken ? { nextToken } : {}) }),
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || '振込の明細を更新できません');
    saved += Number(result?.saved) || 0;
    nextToken = typeof result?.nextToken === 'string' ? result.nextToken : undefined;
    if (!nextToken) break;
    await new Promise(resolve => setTimeout(resolve, 2100));
  }
  return { saved };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return respond(405, { error: 'POSTのみ利用できます' });
  const token = req.headers.get('x-amazon-cron-token');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return respond(401, { error: '定期更新の認証が必要です' });
  const db = database();
  const { data: verified, error } = await db.rpc('verify_amazon_cron_token', { p_token: token });
  if (error || verified !== true) return respond(401, { error: '定期更新の認証に失敗しました' });
  const accounts = amazonAccounts().filter(account => account.configured);
  if (!accounts.length) return respond(503, { error: 'Amazonアカウントが未設定です' });
  const results = [];
  for (const account of accounts) {
    try {
      const credentials = amazonCredentials(account.id);
      const groups = await fetchPayoutGroups({
        token: await accessToken(credentials), accountKey: await sellerAccountKey(credentials.sellerId),
        accountLabel: account.id === 'amazon-2' ? 'Amazon2' : 'Amazon1',
      });
      if (groups.length) {
        const { error: saveError } = await db.from('amazon_payout_groups').upsert(groups, { onConflict: 'account_key,group_id' });
        if (saveError) throw new Error('Amazonの振込一覧を保存できませんでした');
      }
      const accountKey = await sellerAccountKey(credentials.sellerId);
      const history = await refreshLatestPayoutHistory(db, token, account.id, accountKey, groups).catch((e: unknown) => ({
        error: e instanceof Error ? e.message : '振込の明細を更新できません',
      }));
      results.push({ account: account.label, ok: true, groups: groups.length, history });
    } catch (e) {
      results.push({ account: account.label, ok: false, error: e instanceof Error ? e.message : 'Amazonの振込一覧を更新できません' });
    }
  }
  return respond(results.some(result => result.ok) ? 200 : 503, { accounts: results });
}

if (import.meta.main) Deno.serve(handler);
