import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { amazonAccounts, amazonCredentials, AmazonAccountError, type AmazonAccountId } from '../_shared/amazonAccounts.ts';
import { downloadReport, marketplace, parseCustomerReturns, parseRemovalShipments, removalReportType, reportType } from './report.ts';

const path = 'https://sellingpartnerapi-fe.amazon.com/reports/2021-06-30';
type Job = { lease_id: string; report_id: string | null; requested_at: string | null; import_from: string; report_from: string; today: string };
type Row = Record<string, unknown>;
class SyncError extends Error {
  constructor(message: string, readonly httpStatus?: number) { super(message); }
}
const day = (date: number) => new Date(date + 9 * 3600000).toISOString().slice(0, 10);
const returns = { type: reportType, name: 'FBA返品レポート', table: 'amazon_fba_return_sync',
  claim: 'claim_amazon_fba_return_sync', write: 'import_amazon_fba_customer_returns' } as const;
const removals = { type: removalReportType, name: 'FBA返送出荷明細', table: 'amazon_fba_removal_sync',
  claim: 'claim_amazon_fba_removal_sync', write: 'import_amazon_fba_removal_tracking' } as const;

async function accessToken(accountId: AmazonAccountId): Promise<string> {
  const credentials = amazonCredentials(accountId);
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
      client_id: credentials.clientId, client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || typeof value?.access_token !== 'string') throw new SyncError('Amazonの認証に失敗しました');
  return value.access_token;
}

async function reportsApi(token: string, name: string, route: string, body?: Row): Promise<Row> {
  const response = await fetch(path + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new SyncError(
    response.status === 403 ? `Amazonの${name}取得権限を確認してください（403）`
      : `Amazonの${name}を取得できません（HTTP ${response.status}）`,
    response.status,
  );
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SyncError(`Amazonの${name}の応答が不正です`);
  return data;
}

function database() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false },
  });
}
type Database = ReturnType<typeof database>;

async function runReport(db: Database, accountId: AmazonAccountId, reportConfig: typeof returns | typeof removals, getToken: () => Promise<string>) {
  const { type, name, table, claim, write } = reportConfig;
  const isRemoval = type === removalReportType;
  const { data, error } = await db.rpc(claim, { p_account_id: accountId });
  if (error) throw new SyncError(`${name}の処理状態を読み込めません`);
  if (!data) return { state: 'idle' };
  const job = data as Job;
  async function save(patch: Row) {
    const { data: state, error: saveError } = await db.from(table)
      .update({ ...patch, lease_id: null, lease_until: null })
      .eq('account_id', accountId).eq('lease_id', job.lease_id).select('account_id').maybeSingle();
    if (saveError || !state) throw new SyncError(`${name}の処理状態を保存できません`);
  }

  let discardReport = false;
  try {
    const token = await getToken();
    if (!job.report_id) {
      const requestedAt = new Date(Date.now() - 1000).toISOString();
      const result = await reportsApi(token, name, '/reports', {
        reportType: type, marketplaceIds: [marketplace],
        dataStartTime: new Date(job.report_from + 'T00:00:00+09:00').toISOString(),
        dataEndTime: requestedAt,
      });
      if (typeof result.reportId !== 'string' || !result.reportId || result.reportId.length > 200) {
        throw new SyncError(`${name}の受付番号を確認できません`);
      }
      await save({ report_id: result.reportId, requested_at: requestedAt, last_error: null, retry_at: null });
      return { state: 'requested' };
    }
    const report = await reportsApi(token, name, '/reports/' + encodeURIComponent(job.report_id));
    if (report.reportId !== job.report_id || report.reportType !== type ||
      (report.marketplaceIds != null && (!Array.isArray(report.marketplaceIds) ||
        report.marketplaceIds.length !== 1 || report.marketplaceIds[0] !== marketplace))) {
      throw new SyncError(`取得したレポートが日本の${name}と一致しません`);
    }
    if (report.processingStatus === 'IN_QUEUE' || report.processingStatus === 'IN_PROGRESS') {
      if (job.requested_at && Date.now() - Date.parse(job.requested_at) > 48 * 3600000) {
        discardReport = true;
        throw new SyncError(`Amazonの${name}の生成が48時間を超えました`);
      }
      await save({ last_error: null, retry_at: null });
      return { state: 'pending' };
    }

    const complete = {
      report_id: null, requested_at: null, retry_at: null, last_error: null,
      completed_at: new Date().toISOString(),
      last_completed_on: job.requested_at ? day(Date.parse(job.requested_at)) : job.today,
    };
    // Amazon marks a report with no data as CANCELLED. No inventory row is derived from it.
    if (report.processingStatus === 'CANCELLED' && !report.reportDocumentId) {
      await save(complete);
      return { state: 'no_data' };
    }
    if (report.processingStatus === 'FATAL') discardReport = true;
    if (report.processingStatus !== 'DONE' || typeof report.reportDocumentId !== 'string' || !report.reportDocumentId) {
      throw new SyncError(`Amazonが${name}を生成できませんでした`);
    }

    const document = await reportsApi(token, name, '/documents/' + encodeURIComponent(report.reportDocumentId));
    if (document.reportDocumentId !== report.reportDocumentId) throw new SyncError(`${name}の文書IDが一致しません`);
    let rows;
    try {
      const tsv = await downloadReport(document.url, document.compressionAlgorithm);
      rows = isRemoval ? parseRemovalShipments(tsv) : parseCustomerReturns(tsv, job.import_from);
    } catch {
      throw new SyncError(`${name}を読み取れません。ダウンロードと列形式を確認してください`);
    }
    const keys = isRemoval ? ['updated', 'review'] : ['imported', 'linked', 'review'];
    const totals: Record<string, number> = Object.fromEntries(keys.map(key => [key, 0]));
    for (let offset = 0; offset < rows.length; offset += 100) {
      const { data: counts, error: importError } = await db.rpc(write, {
        p_account_id: accountId, p_lease_id: job.lease_id, p_report_id: job.report_id, p_rows: rows.slice(offset, offset + 100),
      });
      if (importError) {
        console.error(write + ' failed:', importError.code);
        throw new SyncError(`${name}の登録に失敗しました`);
      }
      for (const key of keys) {
        if (typeof counts?.[key] !== 'number') throw new SyncError(`${name}の登録結果を確認できません`);
        totals[key] += counts[key];
      }
    }
    await save(complete);
    return { state: 'completed', ...totals };
  } catch (error) {
    const message = error instanceof SyncError || error instanceof AmazonAccountError
      ? error.message : `${name}の取得中に通信エラーが発生しました`;
    const retryMinutes = isRemoval && error instanceof SyncError && error.httpStatus === 403 ? 1440 : 45;
    await save({
      last_error: message, retry_at: new Date(Date.now() + retryMinutes * 60000).toISOString(),
      ...(discardReport ? { report_id: null, requested_at: null } : {}),
    });
    return { state: 'error', error: message };
  }
}

const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return respond(405, { error: 'POSTのみ利用できます' });
  const token = req.headers.get('x-amazon-cron-token');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return respond(401, { error: '定期更新の認証が必要です' });
  const db = database();
  const { data: verified, error } = await db.rpc('verify_amazon_cron_token', { p_token: token });
  if (error || verified !== true) return respond(401, { error: '定期更新の認証に失敗しました' });
  const accounts = amazonAccounts().filter(account => account.hasConfiguration);
  if (!accounts.length) return respond(503, { error: 'Amazonアカウントが未設定です' });
  const results = await Promise.all(accounts.map(async account => {
    let access: Promise<string> | undefined;
    const getToken = () => access ??= accessToken(account.id);
    const run = (config: typeof returns | typeof removals) =>
      runReport(db, account.id, config, getToken).catch(() => ({
        state: 'error', error: `${config.name}の処理状態を更新できません`,
      }));
    const returnResult = await run(returns);
    const tracking = await run(removals);
    return { account_id: account.id, ...returnResult, tracking };
  }));
  return respond(results.every(result => result.state === 'error' && result.tracking.state === 'error') ? 503 : 200, { accounts: results });
}

if (import.meta.main) Deno.serve(handler);
