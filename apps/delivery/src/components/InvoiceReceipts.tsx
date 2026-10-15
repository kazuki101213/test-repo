import { useEffect, useRef, useState } from 'react';
import { loadInvoiceReceipts, uploadInvoiceReceipt, updateInvoiceReceipt, removeInvoiceReceipt, releaseReceiptImages } from '@bussan/shared';
import type { InvoiceReceipt, ReceiptDetails } from '@bussan/shared';
import DateInput from './DateInput';
const blank = (): ReceiptDetails => ({ spent_on: '', description: '', amount: null, payee: '', memo: '', include_in_invoice: true });
const messageOf = (e: unknown) => (e as { message?: string })?.message ?? '保存できませんでした。';
export default function InvoiceReceipts({ staffId, month, approved, onBusyChange, onPrint, onCountChange, onRowsChange, onChanged }: {
  staffId: string; month: string; approved: boolean; onBusyChange: (busy: boolean) => void; onPrint: () => void;
  onCountChange: (count: number) => void; onRowsChange: (rows: InvoiceReceipt[]) => void; onChanged: () => void;
}) {
  const [rows, setRows] = useState<InvoiceReceipt[]>([]);
  const [draft, setDraft] = useState<ReceiptDetails>(blank);
  const [editing, setEditing] = useState<InvoiceReceipt | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { onBusyChange(busy || loading || !!error); return () => onBusyChange(false); }, [busy, loading, error, onBusyChange]);
  useEffect(() => { onCountChange(rows.filter(row => row.document_type !== 'invoice').length); onRowsChange(rows); }, [rows, onCountChange, onRowsChange]);
  useEffect(() => {
    let active = true; let loaded: InvoiceReceipt[] = [];
    setLoading(true); setRows([]); setError('');
    void loadInvoiceReceipts(staffId, month).then(data => { loaded = data; if (active) setRows(data); else releaseReceiptImages(data); })
      .catch(e => { if (active) setError(messageOf(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; releaseReceiptImages(loaded); };
  }, [staffId, month, revision]);
  function reset() { setDraft(blank()); setEditing(null); setFile(null); if (input.current) input.current.value = ''; }
  async function save() {
    if (approved || busy || loading) return;
    if (!draft.spent_on || !draft.description.trim() || draft.amount == null || !Number.isSafeInteger(draft.amount) || draft.amount < 0 || draft.amount > 10000000) { setError('日付・明細名・金額（0〜10,000,000円の整数）を入力してください。'); return; }
    if (!editing && !file) { setError('写真またはPDFを1件選択してください。'); return; }
    setBusy(true); setError('');
    try {
      const details = { ...draft, description: draft.description.trim(), payee: draft.payee.trim() };
      if (editing) await updateInvoiceReceipt(editing, details);
      else if (file) await uploadInvoiceReceipt(staffId, month, file, file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') ? 'receipt' : 'receipt_photo', details);
      reset(); onChanged(); setRevision(n => n + 1);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function remove(row: InvoiceReceipt) {
    if (!window.confirm(`「${row.description || row.original_name}」を明細表から削除しますか？`)) return;
    setBusy(true); setError('');
    try { await removeInvoiceReceipt(row.id); if (editing?.id === row.id) reset(); onChanged(); setRevision(n => n + 1); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  const receipts = rows.filter(row => row.document_type !== 'invoice');
  const claimed = receipts.filter(row => row.include_in_invoice);
  return <section className="invoice-receipts">
    <div className="receipt-editor no-print"><h3>領収書登録</h3>
      
      {!approved && <form className="receipt-detail-form" onChange={onChanged} onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy || loading}><legend>{editing ? '明細を編集' : '明細を登録'}</legend>
          <label>日付<DateInput required value={draft.spent_on ?? ''} onChange={e => setDraft({ ...draft, spent_on: e.target.value })} /></label>
          <label>明細名<input required maxLength={200} placeholder="送料・梱包資材など" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
          <label>金額（税込・円）<input required type="number" min="0" max="10000000" step="1" value={draft.amount ?? ''} onChange={e => setDraft({ ...draft, amount: Number.isNaN(e.target.valueAsNumber) ? null : e.target.valueAsNumber })} /></label>
          {editing ? <p>添付：{editing.original_name}</p> : <label>写真またはPDF（1件・20MB以内）<input ref={input} required type="file" accept="image/*,application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>}
          <details><summary>支払先・備考（任意）</summary><label>支払先<input maxLength={200} value={draft.payee} onChange={e => setDraft({ ...draft, payee: e.target.value })} /></label><label>備考<textarea maxLength={2000} rows={2} value={draft.memo} onChange={e => setDraft({ ...draft, memo: e.target.value })} /></label></details>
          <label className="receipt-claim"><input type="checkbox" checked={draft.include_in_invoice} onChange={e => setDraft({ ...draft, include_in_invoice: e.target.checked })} />請求書に含める</label>
          <div className="row"><button className="btn">{editing ? '明細を保存' : '明細を登録'}</button>{editing && <button type="button" className="btn ghost" onClick={reset}>編集をやめる</button>}</div>
        </fieldset>
      </form>}
      {busy && <p role="status">明細を保存しています…</p>}{loading && <p role="status">明細を読み込み中…</p>}{error && <div className="error" role="alert">{error}<button type="button" className="btn ghost" disabled={busy} onClick={() => setRevision(n => n + 1)}>再読み込み</button></div>}
      <div className="receipt-detail-scroll"><table className="receipt-detail-table"><thead><tr><th>日付</th><th>明細名・支払先</th><th>金額（税込）</th><th>添付</th><th>請求</th>{!approved && <th>操作</th>}</tr></thead>
        <tbody>{receipts.map(row => <tr key={row.id}><td>{row.spent_on || '未登録'}</td><td>{row.description || '未登録'}{row.payee && <small>{row.payee}</small>}{row.memo && <small>{row.memo}</small>}</td><td>{row.amount == null ? '未登録' : `¥${row.amount.toLocaleString('ja-JP')}`}</td><td><a href={row.url} target="_blank" rel="noreferrer">{row.mime_type === 'application/pdf' ? 'PDF' : '写真'}</a></td><td>{row.include_in_invoice ? '含める' : '含めない'}</td>{!approved && <td><button type="button" className="btn ghost" disabled={busy || loading} onClick={() => { setEditing(row); setDraft({ spent_on: row.spent_on ?? '', description: row.description ?? '', amount: row.amount ?? null, payee: row.payee ?? '', memo: row.memo ?? '', include_in_invoice: row.include_in_invoice ?? false }); setError(''); }}>編集</button><button type="button" className="btn ghost" disabled={busy || loading} onClick={() => void remove(row)}>削除</button></td>}</tr>)}</tbody>
        <tfoot><tr><th colSpan={2}>請求に含める合計</th><td colSpan={approved ? 3 : 4}>¥{claimed.reduce((sum, row) => sum + (row.amount ?? 0), 0).toLocaleString('ja-JP')}</td></tr></tfoot></table></div>
      {!loading && !receipts.length && <p>登録済みの明細はありません。</p>}
      {rows.filter(row => row.document_type === 'invoice').map(row => <p key={row.id}>以前の請求書添付：<a href={row.url} target="_blank" rel="noreferrer">{row.original_name}</a></p>)}
      <p className="muted">以前の添付は残しています。未登録の項目を編集すると、請求書に含められます。</p>
      <button type="button" className="btn ghost" disabled={!receipts.length || loading || busy} onClick={onPrint}>明細表・領収書PDF保存</button>
    </div>
  </section>;
}