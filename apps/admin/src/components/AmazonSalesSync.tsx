import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type Range = { postedAfter: string; postedBefore: string };
type Result = { sku: string; status: 'applied' | 'unchanged' | 'review'; reason: string };
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
  const [start, setStart] = useState(() => day(new Date(Date.now() - 29 * 86400000)));
  const [end, setEnd] = useState(() => day(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const stop = useRef(false);
  const running = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  useEffect(() => {
    let active = true;
    getSupabase().from('items').select('purchased_at').not('purchased_at', 'is', null)
      .order('purchased_at', { ascending: true }).limit(1).maybeSingle()
      .then(({ data }) => { if (active && data?.purchased_at) setStart(data.purchased_at); });
    return () => { active = false; };
  }, []);
  async function run(fetchNew: boolean) {
    if (running.current) return;
    running.current = true; stop.current = false;
    setBusy(true); setError(''); setResults([]); setNotice('取得期間を確認中…');
    let saved = 0;
    try {
      const after = Date.parse(`${start}T00:00:00+09:00`);
      const before = Math.min(Date.parse(`${end}T00:00:00+09:00`) + 86400000, Date.now() - 180000);
      if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after) throw new Error('開始日・終了日を確認してください。');
      const all: Result[] = [];
      let processed = 0;
      for (let cursor = after; cursor < before && !stop.current; cursor += 179 * 86400000) {
      const range: Range = { postedAfter: new Date(cursor).toISOString(), postedBefore: new Date(Math.min(cursor + 179 * 86400000, before)).toISOString() };
      if (fetchNew) {
        let nextToken: string | undefined;
        const seen = new Set<string>();
        do {
          if (stop.current) break;
          const page = await invoke({ action: 'sync', ...range, ...(nextToken ? { nextToken } : {}) });
          saved += page.saved; setNotice(`Amazonの履歴を取得中… ${saved}件保存済み（${day(new Date(cursor))}から）`);
          nextToken = page.nextToken;
          if (nextToken && seen.has(nextToken)) throw new Error('Amazonのページ情報が重複しました。保存済み履歴から照合を再開できます。');
          if (nextToken) { seen.add(nextToken); await new Promise(resolve => setTimeout(resolve, 2100)); }
        } while (nextToken);
      }
      let offset = 0, more = true;
      while (more && !stop.current) {
        const history = await invoke({ action: 'history', ...range, offset });
        more = history.hasMore; offset += 100;
        for (const row of history.rows as { transaction_id: string }[]) {
          if (stop.current) break;
          const match = await invoke({ action: 'reconcile', ...range, transactionId: row.transaction_id });
          all.push(...match.results); processed++;
          setResults([...all]); setNotice(`${processed}取引を照合しました。反映 ${all.filter(r => r.status === 'applied').length}件・確認対象 ${all.filter(r => r.status === 'review').length}件`);
          if (match.results.some((r: Result) => r.status === 'applied')) onApplied();
          await new Promise(resolve => setTimeout(resolve, 2100));
        }
      }
      }
      if (stop.current) setNotice('停止しました。反映済みの内容は保存されています。同じ期間で再開できます。');
      else setNotice(`照合完了：反映 ${all.filter(r => r.status === 'applied').length}件／反映済み ${all.filter(r => r.status === 'unchanged').length}件／確認対象 ${all.filter(r => r.status === 'review').length}件。`);
    } catch (e) { setError(e instanceof Error ? e.message : '照合に失敗しました。'); setNotice('途中まで保存・反映した内容は保持されています。同じ期間で再実行できます。'); }
    finally { running.current = false; setBusy(false); onApplied(); }
  }
  return <details className="card amazon-sales">
    <summary>Amazon情報更新</summary>
    <p className="sub" style={{ marginTop: 12 }}>SKU、または同じ通番号の本体行と照合し、注文日・販売価格・商品別の手数料控除後金額を1商品につき1回だけ記入します。仕入先ごとの行は残します。既存の販売記録と異なるものは確認対象になります。</p>
    <div className="toolbar">
      <label className="field"><span>Amazon計上期間・開始日</span><input type="date" value={start} disabled={busy} onChange={e => setStart(e.target.value)} /></label>
      <label className="field"><span>終了日</span><input type="date" value={end} disabled={busy} onChange={e => setEnd(e.target.value)} /></label>
      <button className="btn primary" disabled={busy} onClick={() => void run(true)}>Amazon情報更新</button>
      <button className="btn" disabled={busy} onClick={() => void run(false)}>保存済み履歴から再照合</button>
      {busy && <button className="btn" onClick={() => { stop.current = true; }}>現在の処理後に停止</button>}
    </div>
    <p className="sub">振込額は商品別の控除後金額です。銀行への着金確認ではありません。保留・返金・複数個販売は自動記入しません。Amazonへの更新は行いません。</p>
    {notice && <p role="status">{notice}</p>}
    {error && <div className="error" role="alert">{error}</div>}
    {results.length > 0 && <div className="scroll"><table><thead><tr><th>SKU</th><th>照合結果</th></tr></thead><tbody>{results.map((r, i) => <tr key={i}><td className="sku">{r.sku}</td><td>{r.reason}</td></tr>)}</tbody></table></div>}
  </details>;
}
