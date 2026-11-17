import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';
import AmazonSoldOutReview from './AmazonSoldOutReview';

type Range = { postedAfter: string; postedBefore: string };
type ListingResult = {
  label: string;
  state: 'pending' | 'completed' | 'recent' | 'error';
  active?: number;
  inactive?: number;
  error?: string;
};
type ListingStatus = {
  account_id: 'amazon-1' | 'amazon-2';
  snapshot_at: string | null;
  pending: boolean;
  last_error: string | null;
  unknown_rows: number | null;
  seller_count: number | null;
  inventory_count: number;
  amazon_only: string[] | null;
  inventory_only: string[] | null;
};
const listingDate = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
});
const listingLabel = { 'amazon-1': 'Amazon1', 'amazon-2': 'Amazon2' };

function unavailableAmazon1Report(account: string, error?: string | null) {
  return account === 'Amazon1' && !!error && /全出品レポート.*HTTP\s*403/.test(error);
}

function ListingSyncStatus({ row }: { row: ListingStatus }) {
  const amazonOnly = row.amazon_only ?? [];
  const inventoryOnly = row.inventory_only ?? [];
  const countDiffers = row.seller_count !== row.inventory_count;
  const hasDifferences = amazonOnly.length > 0 || inventoryOnly.length > 0 || countDiffers;
  const outdated = row.snapshot_at !== null && Date.now() - Date.parse(row.snapshot_at) > 27 * 3600000;
  let state = '一致';
  if (row.last_error) state = '取得失敗';
  else if (row.pending) state = '取得中';
  else if (row.seller_count === null) state = '未照合';
  else if (outdated) state = '更新遅れ';
  else if (row.unknown_rows) state = '読み取り要確認';
  else if (hasDifferences) state = '差分あり';

  return <div className="sub">
    <span>{listingLabel[row.account_id]} {state}
      {row.snapshot_at && `（${listingDate.format(new Date(row.snapshot_at))}）`}
      {row.seller_count !== null && ` セラーセントラル ${row.seller_count}件／アプリ ${row.inventory_count}件`}
    </span>
    {row.last_error && <div className="error">{row.last_error}</div>}
    {!!row.unknown_rows && <div>読み取れなかったレポート行 {row.unknown_rows}件</div>}
    {(amazonOnly.length > 0 || inventoryOnly.length > 0) && <details>
      <summary>出品SKUの差分</summary>
      {amazonOnly.length > 0 && <div>セラーセントラル側のみ（{amazonOnly.length}件） {amazonOnly.join('、')}</div>}
      {inventoryOnly.length > 0 && <div>アプリ側のみ（{inventoryOnly.length}件） {inventoryOnly.join('、')}</div>}
    </details>}
  </div>;
}
const day = (date: Date) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '更新に失敗しました。';
async function invoke(body: object, endpoint = 'amazon-payments') {
  const { data, error } = await getSupabase().functions.invoke(endpoint, { body });
  if (error) {
    const response = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(typeof response?.error === 'string' ? response.error : 'Amazonから取得できませんでした。通信とログイン状態を確認してください。');
  }
  return data;
}

async function syncListings(failures: string[]) {
  let active = 0, inactive = 0;
  const pending: string[] = [];
  try {
    const { accounts } = await invoke({}, 'amazon-seller-inventory');
    for (const row of accounts as ListingResult[]) {
      if (row.state === 'pending') pending.push(row.label);
      if (row.state === 'error' && !unavailableAmazon1Report(row.label, row.error)) failures.push(`${row.label}の出品照合 ${row.error ?? '出品状態を確認できませんでした。'}`);
      if (row.state === 'completed') {
        active += row.active ?? 0;
        inactive += row.inactive ?? 0;
      }
    }
  } catch (cause) { failures.push(`Amazonの出品照合 ${errorText(cause)}`); }
  return { active, inactive, pending };
}

export default function AmazonSalesSync({ onApplied }: { onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [listingStatus, setListingStatus] = useState<ListingStatus[]>([]);
  const running = useRef(false);
  const loadListingStatus = useCallback(async () => {
    const { data, error: failure } = await getSupabase().rpc('read_amazon_listing_sync_status');
    if (failure) return;
    setListingStatus((data as ListingStatus[]).filter(row => !unavailableAmazon1Report(listingLabel[row.account_id], row.last_error)));
  }, []);
  useEffect(() => {
    void loadListingStatus();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadListingStatus();
    }, 5 * 60000);
    window.addEventListener('focus', loadListingStatus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', loadListingStatus);
    };
  }, [loadListingStatus]);

  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(''); setNotice('Amazonの出品状態を確認しています…');
    let saved = 0;
    const failures: string[] = [];
    try {
      const { active, inactive, pending } = await syncListings(failures);
      void loadListingStatus();
      if (active || inactive) onApplied();
      const listingNotice = `出品中へ${active}件・出品停止へ${inactive}件反映${pending.length ? `、${pending.join('・')}の出品レポート作成中（完了後に自動反映）` : ''}`;
      setNotice(`${listingNotice}。Amazonの売上情報を確認しています…`);
      const { data: earliest, error: earliestError } = await getSupabase().from('items').select('purchased_at')
        .not('purchased_at', 'is', null).gte('purchased_at', '2010-01-01').order('purchased_at', { ascending: true }).limit(1).maybeSingle();
      if (earliestError) throw earliestError;
      // Match the existing 2010 fallback; legacy years such as 0026 must not
      // start thousands of obsolete API windows. Never rewrite the source date.
      const after = earliest?.purchased_at ? Date.parse(`${earliest.purchased_at.slice(0, 10)}T00:00:00+09:00`) : Date.UTC(2010, 0, 1);
      const before = Date.now() - 180000;
      if (!Number.isFinite(after) || before <= after) throw new Error('更新対象期間を取得できませんでした。');
      let processed = 0;
      const configuration = await invoke({ action: 'accounts' });
      const accounts = (configuration.accounts as { id: string; label: string; hasConfiguration: boolean }[]).filter(account => account.hasConfiguration);
      if (!accounts.length) throw new Error('Amazonアカウントが未設定です。Supabase Secretsへ登録してください。');
      for (const account of accounts) {
        try {
          for (let cursor = after; cursor < before; cursor += 179 * 86400000) {
            const range: Range = {
              postedAfter: new Date(cursor).toISOString(),
              postedBefore: new Date(Math.min(cursor + 179 * 86400000, before)).toISOString(),
            };
            let nextToken: string | undefined;
            const seen = new Set<string>();
            do {
              const page = await invoke({ action: 'sync', accountId: account.id, ...range, ...(nextToken ? { nextToken } : {}) });
              saved += page.saved;
              setNotice(`${listingNotice}。${account.label}の売上を更新しています… ${saved}件取得済み（${day(new Date(cursor))}から）`);
              nextToken = page.nextToken;
              if (nextToken && seen.has(nextToken)) throw new Error('Amazonのページ情報が重複しました。もう一度実行してください。');
              if (nextToken) { seen.add(nextToken); await new Promise(resolve => setTimeout(resolve, 2100)); }
            } while (nextToken);

            let offset = 0, more = true;
            while (more) {
              const history = await invoke({ action: 'history', accountId: account.id, ...range, offset });
              more = history.hasMore; offset += 100;
              for (const row of history.rows as { transaction_id: string }[]) {
                const match = await invoke({ action: 'reconcile', accountId: account.id, ...range, transactionId: row.transaction_id });
                processed++;
                if (match.results.some((result: { status: string }) => result.status === 'applied')) onApplied();
                if (processed % 20 === 0) setNotice(`${listingNotice}。${saved}件取得・${processed}件照合済み`);
                await new Promise(resolve => setTimeout(resolve, 2100));
              }
            }
          }
        } catch (e) {
          failures.push(`${account.label}: ${e instanceof Error ? e.message : '更新に失敗しました。'}`);
        }
      }
      setNotice(`${failures.length || pending.length ? '更新結果' : '更新完了'}（${listingNotice}、取引${saved}件取得・${processed}件照合）`);
      setError(failures.join(' ／ '));
    } catch (e) {
      setError([...failures, errorText(e)].join(' ／ '));
    } finally {
      running.current = false; setBusy(false); onApplied(); void loadListingStatus();
    }
  }

  return <div className="amazon-sales-update">
    <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? '更新中…' : 'Amazon情報更新'}</button>
    {notice && <span role="status" className="sub">{notice}</span>}
    {error && <span role="alert" className="error">{error}</span>}
    <details>
      <summary>Amazon2の売り切れ出品を確認</summary>
      <AmazonSoldOutReview />
    </details>
    <div className="amazon-listing-status" aria-label="Amazonの出品照合状況">
      {listingStatus.map(row => <ListingSyncStatus key={row.account_id} row={row} />)}
    </div>
  </div>;
}
