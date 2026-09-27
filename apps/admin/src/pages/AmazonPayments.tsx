import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type Breakdown = { label: string | null; amount: number | null; currency: string | null; children: Breakdown[] };
type Row = { transaction_id: string; posted_at: string; transaction_type: string | null; status: string | null; description: string | null; amount: number | null; currency: string | null; order_id: string | null; payment_date: string | null; breakdowns: Breakdown[]; item_breakdowns: { breakdowns: Breakdown[] }[]; fetched_at: string };
type Range = { postedAfter: string; postedBefore: string };
type Cursor = Range & { nextToken: string; saved: number };
const date = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
function rangeFor(start: string, end: string): Range {
  const after = new Date(`${start}T00:00:00+09:00`).getTime();
  const before = Math.min(new Date(`${end}T00:00:00+09:00`).getTime() + 86400000, Date.now() - 180000);
  if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after || before - after > 180 * 86400000) throw new Error('開始日・終了日を180日以内で指定してください。');
  return { postedAfter: new Date(after).toISOString(), postedBefore: new Date(before).toISOString() };
}
function money(amount: number | null, currency: string | null) { return amount === null ? '金額不明' : `${Number(amount).toLocaleString('ja-JP', { maximumFractionDigits: 6 })} ${currency ?? ''}`; }
const statuses: Record<string, string> = { DEFERRED: '保留中', RELEASED: '支払対象', DEFERRED_RELEASED: '保留解除・支払対象' };
function BreakdownList({ rows }: { rows: Breakdown[] }) {
  return <ul>{rows.map((b, i) => <li key={i}>{b.label ?? '内訳'}: {money(b.amount, b.currency)}{b.children.length > 0 && <BreakdownList rows={b.children} />}</li>)}</ul>;
}
async function invoke(body: object) {
  const { data, error } = await getSupabase().functions.invoke('amazon-payments', { body });
  if (error) {
    const result = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(typeof result?.error === 'string' ? result.error : 'ペイメントを取得できませんでした。ログイン状態を確認してください。');
  }
  return data;
}
export default function AmazonPayments() {
  const [start, setStart] = useState(() => date(new Date(Date.now() - 29 * 86400000)));
  const [end, setEnd] = useState(() => date(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [history, setHistory] = useState<{ range: Range; offset: number; more: boolean } | null>(null);
  async function readHistory(range: Range, offset = 0) {
    const data = await invoke({ action: 'history', ...range, offset });
    setRows(data.rows); setHistory({ range, offset, more: data.hasMore });
  }
  async function loadHistory(offset = 0, fixedRange?: Range) {
    setBusy(true); setError('');
    try { await readHistory(fixedRange ?? rangeFor(start, end), offset); }
    catch (e) { setError(e instanceof Error ? e.message : '履歴を読み込めません。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void loadHistory(); }, []);
  async function sync(next?: Cursor) {
    setBusy(true); setError(''); setNotice('');
    try {
      const range = next ?? rangeFor(start, end);
      const data = await invoke({ action: 'sync', postedAfter: range.postedAfter, postedBefore: range.postedBefore, ...(next ? { nextToken: next.nextToken } : {}) });
      const saved = (next?.saved ?? 0) + data.saved;
      setCursor(data.nextToken ? { postedAfter: range.postedAfter, postedBefore: range.postedBefore, nextToken: data.nextToken, saved } : null);
      setNotice(`${saved}件分の保存・更新を処理しました。${data.nextToken ? '続きがあります。「続きを取得・保存」を押してください。' : '指定期間の全ページを取得しました。'}`);
      await readHistory(range);
    } catch (e) { setError(e instanceof Error ? e.message : '同期できませんでした。'); }
    finally { setBusy(false); }
  }
  function changeDates(which: 'start' | 'end', value: string) { (which === 'start' ? setStart : setEnd)(value); setCursor(null); setNotice(''); setRows([]); setHistory(null); setError(''); }
  return <>
    <h2>Amazon ペイメント</h2>
    <p className="sub">Amazon.co.jpの売上・手数料・返金などの取引履歴を取得し、アプリに保存します。同じ取引は重複登録せず更新します。</p>
    <div className="toolbar">
      <label>開始日（日本時間）<input aria-label="開始日" type="date" value={start} disabled={busy} onChange={e => changeDates('start', e.target.value)} /></label>
      <label>終了日（日本時間）<input aria-label="終了日" type="date" value={end} disabled={busy} onChange={e => changeDates('end', e.target.value)} /></label>
      <button className="btn" disabled={busy} onClick={() => void loadHistory()}>保存済み履歴を表示</button>
      <button className="btn primary" disabled={busy} onClick={() => { setCursor(null); void sync(); }}>Amazonから取得・保存</button>
      {cursor && <button className="btn" disabled={busy} onClick={() => void sync(cursor)}>続きを取得・保存</button>}
    </div>
    {busy && <p role="status">処理中…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <div className="error" role="alert">{error}</div>}
    <p className="sub">Amazonへの更新は行いません。直近48時間の取引が反映されないことがあります。「支払対象」は銀行への着金確認ではありません。内訳は親項目と子項目を重ねて合算しないでください。</p>
    {history && <>
      <p>保存済み履歴: {rows.length}件表示（{history.offset + 1}件目から）</p>
      <div className="scroll"><table><thead><tr><th>計上日時</th><th>取引</th><th>状態</th><th>金額</th><th>注文ID</th><th>詳細</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.transaction_id}><td>{new Date(row.posted_at).toLocaleString('ja-JP')}</td><td>{row.transaction_type ?? '不明'}<br />{row.description}</td><td>{statuses[row.status ?? ''] ?? row.status ?? '不明'}</td><td>{money(row.amount, row.currency)}</td><td>{row.order_id ?? '—'}</td><td>
          <details><summary>金額内訳・取得日時</summary><p>取引ID: {row.transaction_id}</p><p>最終取得: {new Date(row.fetched_at).toLocaleString('ja-JP')}</p>{row.payment_date && <p>Amazon支払日: {new Date(row.payment_date).toLocaleString('ja-JP')}</p>}
          <BreakdownList rows={row.breakdowns} />{row.item_breakdowns.map((item, index) => item.breakdowns.length > 0 && <div key={index}>商品内訳 {index + 1}<BreakdownList rows={item.breakdowns} /></div>)}</details>
        </td></tr>)}
      </tbody></table></div>
      {!rows.length && <p>この期間の保存済み履歴はありません。未取得の場合は「Amazonから取得・保存」を押してください。</p>}
      <div className="toolbar"><button className="btn" disabled={busy || history.offset === 0} onClick={() => void loadHistory(history.offset - 100, history.range)}>前の100件</button><button className="btn" disabled={busy || !history.more} onClick={() => void loadHistory(history.offset + 100, history.range)}>次の100件</button></div>
    </>}
  </>;
}
