// Amazon JP の振込グループ（Finances v0 financialEventGroups）を取り込む。
// 1グループ＝1回の振込。読み取りのみで、Amazonへは書き込まない。

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown, max = 200): string | null => typeof v === 'string' && v ? v.slice(0, max) : null;
const time = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const money = (v: unknown): number | null => {
  const amount = obj(v).CurrencyAmount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
};

export type PayoutGroup = {
  account_key: string; group_id: string; account_label: 'Amazon1' | 'Amazon2';
  processing_status: string | null; fund_transfer_status: string | null;
  total: number | null; currency: string | null; fund_transfer_date: string | null;
  group_start: string | null; group_end: string | null; fetched_at: string;
};

export function normalizePayoutGroup(value: unknown, accountKey: string, accountLabel: 'Amazon1' | 'Amazon2', fetchedAt: string): PayoutGroup | null {
  const g = obj(value);
  const id = text(g.FinancialEventGroupId, 500);
  if (!id) return null;
  return {
    account_key: accountKey, group_id: id, account_label: accountLabel,
    processing_status: text(g.ProcessingStatus, 40), fund_transfer_status: text(g.FundTransferStatus, 40),
    total: money(g.OriginalTotal), currency: text(obj(g.OriginalTotal).CurrencyCode, 3),
    fund_transfer_date: time(g.FundTransferDate), group_start: time(g.FinancialEventGroupStart),
    group_end: time(g.FinancialEventGroupEnd), fetched_at: fetchedAt,
  };
}

export async function fetchPayoutGroups(options: {
  token: string; accountKey: string; accountLabel: 'Amazon1' | 'Amazon2'; days?: number;
  fetcher?: typeof fetch; wait?: (ms: number) => Promise<void>; now?: number;
}): Promise<PayoutGroup[]> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now();
  const startedAfter = new Date(now - (options.days ?? 60) * 86400000).toISOString();
  const fetchedAt = new Date(now).toISOString();
  const groups: PayoutGroup[] = [];
  const seen = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams(nextToken ? { NextToken: nextToken } : { FinancialEventGroupStartedAfter: startedAfter, MaxResultsPerPage: '100' });
    const response = await fetcher(`https://sellingpartnerapi-fe.amazon.com/finances/v0/financialEventGroups?${params}`, {
      headers: { 'x-amz-access-token': options.token, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), 'user-agent': 'BussanAdmin/1.0 (Language=TypeScript; Platform=Supabase)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const hint = response.status === 403 ? '出品者用「財務会計」ロールと、ロール追加後のアプリ再認可を確認してください。' : response.status === 429 ? '取得制限です。時間をおいて再試行してください。' : 'Amazonの設定・稼働状況を確認してください。';
      throw new Error(`Amazonの振込一覧を取得できません（HTTP ${response.status}）。${hint}`);
    }
    const payload = obj(obj(await response.json().catch(() => null)).payload);
    for (const entry of list(payload.FinancialEventGroupList)) {
      const group = normalizePayoutGroup(entry, options.accountKey, options.accountLabel, fetchedAt);
      if (group) groups.push(group);
    }
    const token = text(payload.NextToken, 10000) ?? undefined;
    if (!token || seen.has(token)) break;
    seen.add(token);
    nextToken = token;
    await wait(2100);
  }
  return [...new Map(groups.map(group => [group.group_id, group])).values()];
}
