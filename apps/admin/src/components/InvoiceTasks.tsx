import { useEffect, useRef, useState } from 'react';
import { getSupabase, yen } from '@bussan/shared';

interface Line { date: string | null; description: string; quantity: number; unit_price: number; lot_seq?: number }
interface Approval { approved_at: string; expense_id: string }
interface InvoiceTask {
  id: string; billing_month: string; issued_on: string; total: number; version: number; updated_at: string; note: string;
  snapshot: { profile: Record<string, string>; lines: Line[]; extras: Line[]; tax: number };
  delivery_invoice_approvals: Approval | Approval[] | null;
}
const approval = (row: InvoiceTask) => Array.isArray(row.delivery_invoice_approvals) ? row.delivery_invoice_approvals[0] : row.delivery_invoice_approvals;
const messageOf = (e: unknown) => e instanceof Error ? e.message : (e as { message?: string })?.message ?? '処理に失敗しました。';
const monthEnd = (month: string) => {
  const date = new Date(month + 'T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
};
async function fetchTasks(): Promise<InvoiceTask[]> {
  const rows: InvoiceTask[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await getSupabase().from('delivery_invoices')
      .select('id,billing_month,issued_on,total,version,updated_at,note,snapshot,delivery_invoice_approvals(approved_at,expense_id)')
      .order('updated_at', { ascending: false }).order('id').range(start, start + 499);
    if (error) throw error;
    rows.push(...data as unknown as InvoiceTask[]);
    if (data.length < 500) return rows;
  }
}

function InvoiceReview({ invoice, onClose, onApproved }: { invoice: InvoiceTask; onClose: () => void; onApproved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [date, setDate] = useState(() => monthEnd(invoice.billing_month));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = invoice.snapshot.profile;
  const approved = approval(invoice);
  const lines = [...invoice.snapshot.lines, ...invoice.snapshot.extras];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function approve() {
    setBusy(true); setError('');
    try {
      const { error } = await getSupabase().rpc('approve_delivery_invoice', { p_invoice: invoice.id, p_version: invoice.version, p_incurred_on: date });
      if (error) throw error;
      onApproved();
    } catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="monthly-detail invoice-review" aria-labelledby="invoice-review-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="toolbar"><h2 id="invoice-review-title">{p.issuer_name} · {invoice.billing_month.slice(0, 7)} 請求書</h2><span style={{ flex: 1 }} /><button className="btn" disabled={busy} onClick={onClose} autoFocus>閉じる</button></div>
    <p>請求日：{invoice.issued_on}　請求金額：<strong>{yen(invoice.total)}</strong>　{approved ? '承認済み' : '承認待ち'}</p>
    <div className="scroll" style={{ maxHeight: '45vh' }}><table><thead><tr><th>購入日／日付</th><th>内容</th><th className="num">数量</th><th className="num">単価</th><th className="num">金額</th></tr></thead>
      <tbody>{lines.map((line, i) => <tr key={i}><td>{line.date ?? '—'}</td><td className="detail-description">{line.description}{line.lot_seq != null && `（${line.lot_seq}）`}</td><td className="num">{line.quantity}</td><td className="num">{yen(line.unit_price)}</td><td className="num">{yen(line.quantity * line.unit_price)}</td></tr>)}</tbody></table></div>
    {invoice.note && <p style={{ whiteSpace: 'pre-wrap' }}>{invoice.note}</p>}
    <details style={{ margin: '16px 0' }}><summary>請求者・振込先</summary><p style={{ whiteSpace: 'pre-line' }}>{p.issuer_name}<br />{p.postal} {p.address}<br />{p.phone} / {p.email}<br /><br />{p.bank}（{p.bank_code}） {p.branch}（{p.branch_code}）<br />{p.account_type} {p.account_number}<br />{p.holder}<br />{p.holder_kana}</p></details>
    {error && <div className="error" role="alert">{error}</div>}
    {!approved && <form onSubmit={e => { e.preventDefault(); void approve(); }}><div className="toolbar"><label className="field"><span>経費の計上日</span><input type="date" required value={date} disabled={busy} onChange={e => setDate(e.target.value)} /></label><button className="btn primary" disabled={busy || invoice.total <= 0}>{busy ? '承認中…' : '承認して外注費に追加'}</button></div></form>}
    {approved && <p className="ok">承認済み・経費一覧に追加済みです。</p>}
  </dialog>;
}

export default function InvoiceTasks({ onApproved }: { onApproved: () => void }) {
  const [rows, setRows] = useState<InvoiceTask[]>([]);
  const [filter, setFilter] = useState<'pending' | 'approved'>('pending');
  const [selected, setSelected] = useState<InvoiceTask | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try { const data = await fetchTasks(); if (active) { setRows(data); setError(''); } }
      catch (e) { if (active) setError(messageOf(e)); }
      finally { fetching = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [revision]);
  const pending = rows.filter(row => !approval(row)).length;
  const filtered = rows.filter(row => filter === 'pending' ? !approval(row) : !!approval(row));
  return <section className="card invoice-tasks" aria-label="タスク表">
    <div className="toolbar"><h3>タスク表</h3><span>承認待ち {pending}件</span><select aria-label="請求書の状態" value={filter} onChange={e => setFilter(e.target.value as 'pending' | 'approved')}><option value="pending">承認待ち</option><option value="approved">承認済み</option></select></div>
    {error && <div className="error" role="alert">{error}<button className="btn" onClick={() => setRevision(n => n + 1)}>再読み込み</button></div>}
    {message && <p className="ok" role="status">{message}</p>}
    {loading ? <p>読み込み中…</p> : filtered.length === 0 ? <p className="sub">{filter === 'pending' ? '承認待ちの請求書はありません。' : '承認済みの請求書はありません。'}</p> : <ul className="invoice-task-rows">{filtered.map(row => <li key={row.id}><button onClick={() => setSelected(row)}><span>{row.snapshot.profile.issuer_name}<small>{row.billing_month.slice(0, 7)} 請求書</small></span><strong>{yen(row.total)}</strong><span>確認 ›</span></button></li>)}</ul>}
    {selected && <InvoiceReview key={selected.id} invoice={selected} onClose={() => setSelected(null)} onApproved={() => { setSelected(null); setRevision(n => n + 1); setMessage('承認し、経費一覧の外注費に追加しました。'); onApproved(); }} />}
  </section>;
}
