import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createInvoiceReceiptLink, loadInvoiceReceiptHistory, loadInvoiceReceipts, uploadInvoiceReceipt, updateInvoiceReceipt, removeInvoiceReceipt, releaseReceiptImages, reimbursementCategories } from '@bussan/shared';
import type { InvoiceReceipt, InvoiceReceiptSummary, ReceiptDetails } from '@bussan/shared';
import DateInput from './DateInput';
type ReceiptDraft = Omit<ReceiptDetails, 'category' | 'include_in_invoice'> & { category: ReceiptDetails['category'] | null };
const blank = (): ReceiptDraft => ({ spent_on: '', description: '', amount: null, category: null });
const isExcluded = (row: Omit<InvoiceReceipt, 'url'>) => row.include_in_invoice === false && !!row.spent_on && row.amount != null;
const messageOf = (e: unknown) => (e as { message?: string })?.message ?? '保存できませんでした。';
export default function InvoiceReceipts({ staffId, month, historyMonths, approved, disabled = false, tableTarget, onBusyChange, onRowsChange, onChanged, onSavingChange }: {
  staffId: string; month: string; approved: boolean; disabled?: boolean; tableTarget: HTMLElement | null; onBusyChange: (busy: boolean) => void;
  historyMonths?: string[];
  onRowsChange: (rows: InvoiceReceipt[]) => void; onChanged: () => void; onSavingChange?: (saving: boolean) => void;
}) {
  const editable = !approved && !disabled;
  const [rows, setRows] = useState<InvoiceReceipt[]>([]);
  const [draft, setDraft] = useState<ReceiptDraft>(blank);
  const [editing, setEditing] = useState<InvoiceReceipt | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const firstHistoryMonth = historyMonths?.at(-1);
  const lastHistoryMonth = historyMonths?.[0];
  const [history, setHistory] = useState<{ rows: InvoiceReceiptSummary[]; error?: string } | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [attachmentError, setAttachmentError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const editorForm = useRef<HTMLFormElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  useEffect(() => { onSavingChange?.(busy); return () => onSavingChange?.(false); }, [busy, onSavingChange]);
  useEffect(() => { onBusyChange(busy || loading || !!error); return () => onBusyChange(false); }, [busy, loading, error, onBusyChange]);
  useEffect(() => { onRowsChange(rows); }, [rows, onRowsChange]);
  useEffect(() => {
    let active = true; let loaded: InvoiceReceipt[] = [];
    setLoading(true); setRows([]); setError('');
    void loadInvoiceReceipts(staffId, month).then(data => { loaded = data; if (active) setRows(data); else releaseReceiptImages(data); })
      .catch(e => { if (active) setError(messageOf(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; releaseReceiptImages(loaded); };
  }, [staffId, month, revision]);
  useEffect(() => {
    if (!firstHistoryMonth || !lastHistoryMonth) return;
    let active = true;
    setHistory(null);
    void loadInvoiceReceiptHistory(staffId, firstHistoryMonth, lastHistoryMonth)
      .then(data => { if (active) setHistory({ rows: data }); })
      .catch(e => { if (active) setHistory({ rows: [], error: messageOf(e) }); });
    return () => { active = false; };
  }, [staffId, firstHistoryMonth, lastHistoryMonth, revision, historyRevision]);
  function reset() { setDraft(blank()); setEditing(null); setFile(null); setAttachmentMenu(false); if (input.current) input.current.value = ''; if (cameraInput.current) cameraInput.current.value = ''; }
  async function save() {
    if (!editable || busy || loading) return;
    if (!draft.spent_on || !draft.description.trim() || draft.amount == null || !Number.isSafeInteger(draft.amount) || draft.amount < 0 || draft.amount > 10000000) { setError('日付・内容・金額（0〜10,000,000円の整数）を入力してください。'); return; }
    if (!draft.category) { setError('区分を選択してください。'); return; }
    if (!editing && !file) { setError('写真またはPDFを1件選択してください。'); return; }
    setBusy(true); setError('');
    try {
      const details: ReceiptDetails = { ...draft, category: draft.category, description: draft.description.trim(), include_in_invoice: !editing || !isExcluded(editing) };
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
  function edit(row: InvoiceReceipt) {
    setFile(null);
    setAttachmentMenu(false);
    setEditing(row);
    setDraft({ spent_on: row.spent_on ?? '', description: row.description ?? '', amount: row.amount ?? null, category: row.category ?? null });
    setError('');
    editorForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function openReceipt(storagePath: string) {
    setAttachmentError('');
    const tab = window.open('', '_blank');
    if (!tab) { setAttachmentError('ブラウザーでポップアップを許可してください。'); return; }
    tab.opener = null;
    try { tab.location.replace(await createInvoiceReceiptLink(storagePath)); }
    catch { tab.close(); setAttachmentError('添付ファイルを開けませんでした。'); }
  }
  const invoiceRowsById = new Map(rows.map(row => [row.id, row]));
  const tableRows = historyMonths ? history?.rows ?? [] : rows;
  const tableLoading = historyMonths ? !history : loading;
  const tableError = historyMonths ? history?.error : error;
  const canEdit = editable && (!historyMonths || historyMonths.includes(month));
  const receipts = tableRows.filter(row => row.document_type !== 'invoice');
  const attachment = (row: Omit<InvoiceReceipt, 'url'>, label: string) => {
    const url = invoiceRowsById.get(row.id)?.url;
    return url ? <a href={url} target="_blank" rel="noreferrer">{label}</a>
      : <button type="button" className="btn ghost" onClick={() => void openReceipt(row.storage_path)}>{label}</button>;
  };
  return <section className="invoice-receipts">
    {(!approved || busy || loading || error) && <div className="receipt-editor no-print">
      {!approved && <h3>立替支払い</h3>}
      {editable && <form ref={editorForm} className="receipt-detail-form" onChange={onChanged} onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy || loading}>
          <div className="receipt-entry-scroll"><div className="receipt-entry-row">
            <label>日付<DateInput required value={draft.spent_on ?? ''} onChange={e => setDraft({ ...draft, spent_on: e.target.value })} /></label>
            <label>内容<input required maxLength={200} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
            <label>区分<select required value={draft.category ?? ''} onChange={e => setDraft({ ...draft, category: reimbursementCategories.find(category => category === e.target.value) ?? null })}>
              <option value="" disabled>選択してください</option>
              {reimbursementCategories.map(category => <option key={category} value={category}>{category}</option>)}
            </select></label>
            <label>金額<input required type="number" min="0" max="10000000" step="1" value={draft.amount ?? ''} onChange={e => setDraft({ ...draft, amount: Number.isNaN(e.target.valueAsNumber) ? null : e.target.valueAsNumber })} /></label>
            <div className="receipt-entry-actions">
              <div className="receipt-attachment"><span>写真・PDF</span><button type="button" className="btn ghost receipt-camera-btn" aria-label="写真を撮影・写真やPDFを添付" aria-expanded={attachmentMenu} disabled={!!editing} onClick={() => setAttachmentMenu(open => !open)}><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="4" /></svg></button></div>
              <button className="btn primary" type="submit">保存</button>
            </div>
          </div></div>
          {attachmentMenu && <div className="receipt-attachment-options"><button type="button" className="btn ghost" onClick={() => { setAttachmentMenu(false); cameraInput.current?.click(); }}>写真を撮る</button><button type="button" className="btn ghost" onClick={() => { setAttachmentMenu(false); input.current?.click(); }}>写真・PDFを添付</button></div>}
          <input ref={input} hidden type="file" aria-label="写真・PDFを添付" accept="image/*,application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <input ref={cameraInput} hidden type="file" aria-label="写真を撮る" accept="image/*" capture="environment" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          {(file || editing) && <p className="receipt-selected-file">添付：{editing?.original_name ?? file?.name}</p>}
          {editing && <div><button type="button" className="btn ghost" onClick={reset}>編集をやめる</button></div>}
        </fieldset>
      </form>}
      {busy && <p role="status">明細を保存しています…</p>}{loading && <p role="status">明細を読み込み中…</p>}{error && <div className="error" role="alert">{error}<button type="button" className="btn ghost" disabled={busy} onClick={() => setRevision(n => n + 1)}>再読み込み</button></div>}

    </div>}
    {tableTarget && createPortal(<div className="card receipt-list no-print"><h3>領収書明細</h3>
      {tableLoading && <p role="status">明細を読み込み中…</p>}
      {historyMonths && tableError && <div className="error" role="alert">{tableError}<button type="button" className="btn ghost" onClick={() => setHistoryRevision(n => n + 1)}>再読み込み</button></div>}
      {attachmentError && <p className="error" role="alert">{attachmentError}</p>}
      <div className="receipt-detail-scroll"><table className="receipt-detail-table"><thead><tr><th>日付</th><th>内容</th><th>区分</th><th className="receipt-amount">金額</th><th>写真・PDF</th>{canEdit && <th className="receipt-actions-cell" aria-label="明細の編集・削除" />}</tr></thead>
        <tbody>{receipts.map(row => {
          const invoiceRow = invoiceRowsById.get(row.id);
          return <tr key={row.id}>
          <td>{row.spent_on || '未登録'}</td>
          <td>{row.description || '未登録'}{row.payee && <>　{row.payee}</>}{row.memo && <>　{row.memo}</>}{isExcluded(row) && <small className="receipt-excluded">請求対象外</small>}</td>
          <td>{row.category ?? '—'}</td>
          <td className="receipt-amount">{row.amount == null ? '未登録' : `¥${row.amount.toLocaleString('ja-JP')}`}</td>
          <td>{attachment(row, row.mime_type === 'application/pdf' ? 'PDF' : '写真')}</td>
          {canEdit && <td className="receipt-actions-cell">{invoiceRow && <div className="receipt-row-actions">
            <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => edit(invoiceRow)}>編集</button>
            <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => void remove(invoiceRow)}>削除</button>
          </div>}</td>}
        </tr>;
        })}</tbody>
      </table></div>
      {!tableLoading && !tableError && !receipts.length && <p>登録済みの明細はありません。</p>}
      {tableRows.filter(row => row.document_type === 'invoice').map(row => <p key={row.id}>以前の請求書添付：{attachment(row, row.original_name)}</p>)}
    </div>, tableTarget)}
  </section>;
}
