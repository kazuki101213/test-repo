import { useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type Range = { postedAfter: string; postedBefore: string };
const day = (date: Date) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
async function invoke(body: object) {
  const { data, error } = await getSupabase().functions.invoke('amazon-payments', { body });
  if (error) {
    const response = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(typeof response?.error === 'string' ? response.error : 'Amazonから取得できませんでした。通信とログイン状態を確認してください。');
  }
  return data;
}

export default function AmazonSalesSync({ onApplied }: { onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);

  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(''); setNotice('Amazon情報を更新しています…');
    let saved = 0;
    try {
      const { data: earliest, error: earliestError } = await getSupabase().from('items').select('purchased_at')
        .not('purchased_at', 'is', null).order('purchased_at', { ascending: true }).limit(1).maybeSingle();
      if (earliestError) throw earliestError;
      // 期間入力は設けず、在庫の最古の仕入日から現在までを自動で処理する。
      const after = earliest?.purchased_at ? Date.parse(`${earliest.purchased_at.slice(0, 10)}T00:00:00+09:00`) : Date.UTC(2010, 0, 1);
      const before = Date.now() - 180000;
      if (!Number.isFinite(after) || before <= after) throw new Error('更新対象期間を取得できませんでした。');
      let processed = 0;
      const configuration = await invoke({ action: 'accounts' });
      const accounts = (configuration.accounts as { id: string; label: string; hasConfiguration: boolean }[]).filter(account => account.hasConfiguration);
      if (!accounts.length) throw new Error('Amazonアカウントが未設定です。Supabase Secretsへ登録してください。');
      const failures: string[] = [];
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
              setNotice(`${account.label}を更新しています… ${saved}件取得済み（${day(new Date(cursor))}から）`);
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
                if (processed % 20 === 0) setNotice(`Amazon情報を更新しています… ${saved}件取得・${processed}件照合済み`);
                await new Promise(resolve => setTimeout(resolve, 2100));
              }
            }
          }
        } catch (e) {
          failures.push(`${account.label}: ${e instanceof Error ? e.message : '更新に失敗しました。'}`);
        }
      }
      setNotice(`${failures.length ? '更新結果' : '更新完了'}（${saved}件取得、${processed}件照合）`);
      setError(failures.join(' ／ '));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Amazon情報を更新できませんでした。');
      setNotice('');
    } finally {
      running.current = false; setBusy(false); onApplied();
    }
  }

  return <div className="amazon-sales-update">
    <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? '更新中…' : 'Amazon情報更新'}</button>
    {notice && <span role="status" className="sub">{notice}</span>}
    {error && <span role="alert" className="error">{error}</span>}
  </div>;
}
