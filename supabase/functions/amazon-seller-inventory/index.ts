import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials, AmazonAccountError, type AmazonAccountId } from '../_shared/amazonAccounts.ts';
import { downloadReport, marketplace } from '../amazon-fba-returns/report.ts';
import { parseSellerInventory } from './report.ts';

const reportType = 'GET_MERCHANT_LISTINGS_ALL_DATA';
const reportEndpoint = 'https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30';
const headers = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store',
};
const reply = (status: number, body: unknown) => Response.json(body, { status, headers });
const isId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][\w.-]{0,199}$/.test(id);
class InventoryReportError extends Error {}
type Job = { lease_id: string; report_id: string | null; last_started_at: string | null };
const options = { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } };
const serviceClient = (url: string) => createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options);
type Db = ReturnType<typeof serviceClient>;

async function tokenFor(accountId: AmazonAccountId) {
  const credentials = amazonCredentials(accountId);
  const expectedSeller = accountId === 'amazon-2' ? 'A3E7BXJWH9TP11' : 'A1WI3OGPE43N2T';
  if (credentials.sellerId !== expectedSeller) throw new InventoryReportError('出品アカウントの設定が一致しません。');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
      client_id: credentials.clientId, client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.access_token !== 'string') throw new InventoryReportError('Amazonの認証に失敗しました。');
  return data.access_token;
}

async function amazonReport(token: string, path: string, body?: object) {
  const response = await fetch(reportEndpoint + path, {
    method: body ? 'POST' : 'GET', headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new InventoryReportError(`Amazonの全出品レポートを取得できません（HTTP ${response.status}）。`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InventoryReportError('Amazonの全出品レポートの応答が不正です。');
  return data;
}

async function refresh(db: Db, accountId: AmazonAccountId, manual: boolean) {
  const { data, error } = await db.rpc('claim_seller_inventory_report', { p_account: accountId, p_manual: manual });
  if (error) throw new InventoryReportError('在庫管理レポートの取得状況を確認できません。');
  if (!data) {
    const { data: current } = await db.from('amazon_seller_inventory_sync').select('last_snapshot_at,last_error,report_id')
      .eq('account_id', accountId).maybeSingle();
    return { state: current?.report_id ? 'pending' : current?.last_error ? 'error' : 'recent',
      observedAt: current?.last_snapshot_at, error: current?.last_error };
  }
  const job = data as Job;
  async function save(patch: object) {
    const { data: saved, error: saveError } = await db.from('amazon_seller_inventory_sync')
      .update({ ...patch, lease_id: null, lease_until: null })
      .eq('account_id', accountId).eq('lease_id', job.lease_id).select('account_id').maybeSingle();
    if (saveError || !saved) throw new InventoryReportError('在庫管理レポートの取得状況を保存できません。');
  }
  let discard = false;
  let nextPollAt = new Date(Date.now() + 5 * 60000).toISOString();
  try {
    if (job.report_id && job.last_started_at && Date.now() - Date.parse(job.last_started_at) >= 86400000) {
      discard = true;
      throw new InventoryReportError('全出品レポートを24時間以内に反映できませんでした。');
    }
    const token = await tokenFor(accountId);
    if (!job.report_id) {
      const requested = await amazonReport(token, '/reports', {
        reportType, marketplaceIds: [marketplace], reportOptions: { preferredReportDocumentLocale: 'en_US' },
      });
      if (!isId(requested.reportId)) throw new InventoryReportError('全出品レポートの受付番号を確認できません。');
      await save({ report_id: requested.reportId, next_poll_at: nextPollAt, last_error: null });
      return { state: 'pending' };
    }

    const report = await amazonReport(token, '/reports/' + encodeURIComponent(job.report_id));
    if (report.reportId !== job.report_id || report.reportType !== reportType ||
      !Array.isArray(report.marketplaceIds) || report.marketplaceIds.length !== 1 || report.marketplaceIds[0] !== marketplace) {
      discard = true;
      throw new InventoryReportError('日本の全出品レポートと一致しません。');
    }
    if (report.processingStatus === 'IN_QUEUE' || report.processingStatus === 'IN_PROGRESS') {
      await save({ next_poll_at: nextPollAt, last_error: null });
      return { state: 'pending' };
    }
    if (report.processingStatus === 'CANCELLED' || report.processingStatus === 'FATAL') {
      discard = true;
      throw new InventoryReportError(`Amazonが全出品レポートの作成を終了しました（${report.processingStatus}）。`);
    }
    if (report.processingStatus !== 'DONE' || !isId(report.reportDocumentId))
      throw new InventoryReportError('Amazonの全出品レポートの文書番号を確認できません。');
    const snapshotAt = new Date(report.createdTime);
    if (!Number.isFinite(snapshotAt.getTime())) throw new InventoryReportError('全出品レポートの作成日時を確認できません。');
    const doc = await amazonReport(token, '/documents/' + encodeURIComponent(report.reportDocumentId));
    if (doc.reportDocumentId !== report.reportDocumentId) throw new InventoryReportError('全出品レポートの文書番号が一致しません。');
    let listings;
    try {
      listings = parseSellerInventory(await downloadReport(doc.url, doc.compressionAlgorithm));
    }
    catch (cause) {
      throw new InventoryReportError(cause instanceof Error && cause.message.startsWith('全出品レポート')
        ? cause.message : '全出品レポートを読み込めませんでした。');
    }
    // A complete report may contain unrelated listings; only uniquely matched local listings are changed.
    const applied = await db.rpc('apply_seller_inventory_report', {
      p_account: accountId, p_lease: job.lease_id, p_report: job.report_id, p_snapshot: snapshotAt.toISOString(), p_rows: listings.rows,
    });
    if (applied.error || !applied.data) {
      console.error('apply_seller_inventory_report failed:', applied.error?.code);
      throw new InventoryReportError('セラーセントラルの出品状態をアプリに反映できませんでした。');
    }
    return { state: 'completed', observedAt: snapshotAt.toISOString(), ...applied.data, unknown: listings.unknown };
  } catch (cause) {
    const message = cause instanceof InventoryReportError || cause instanceof AmazonAccountError ? cause.message
      : '全出品レポートの取得中にエラーが発生しました。';
    nextPollAt = new Date(Date.now() + 15 * 60000).toISOString();
    await save({ last_error: message, next_poll_at: nextPollAt, ...(discard ? { report_id: null } : {}) });
    return { state: 'error', error: message };
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, { error: 'POSTのみ利用できます。' });
  const url = Deno.env.get('SUPABASE_URL')!;
  const db = serviceClient(url);
  const cron = req.headers.get('x-amazon-cron-token');
  if (cron !== null) {
    const { data, error } = await db.rpc('verify_amazon_cron_token', { p_token: cron });
    if (!data || error) return reply(401, { error: '定期処理の認証が必要です。' });
  } else {
    const authorization = req.headers.get('authorization') ?? '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!bearer) return reply(401, { error: 'ログインが必要です。' });
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { ...options, global: { headers: { Authorization: authorization } } });
    const { data, error } = await client.auth.getUser(bearer);
    if (error || !data.user) return reply(401, { error: '再ログインしてください。' });
    const role = await client.rpc('is_admin');
    if (role.error || role.data !== true) return reply(403, { error: '管理者のみ利用できます。' });
  }
  const body = await req.json().catch(() => null);
  if (body?.accountId !== undefined && !['amazon-1', 'amazon-2'].includes(body.accountId)) return reply(400, { error: 'Amazonアカウントを確認できません。' });
  const accounts = amazonAccounts().filter(account => account.hasConfiguration && (!body?.accountId || body.accountId === account.id));
  if (!accounts.length) return reply(503, { error: 'Amazonアカウントが未設定です。' });
  return reply(200, { accounts: await Promise.all(accounts.map(async account => {
    try { return { accountId: account.id, label: account.label, ...await refresh(db, account.id, cron === null || body?.poll === true) }; }
    catch (cause) { return { accountId: account.id, label: account.label, state: 'error',
      error: cause instanceof InventoryReportError ? cause.message : '出品状態を更新できませんでした。' }; }
  })) });
}

if (import.meta.main) Deno.serve(handler);
