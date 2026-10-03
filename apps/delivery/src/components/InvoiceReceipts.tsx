import { useEffect, useRef, useState } from 'react';
import { loadInvoiceReceipts, uploadInvoiceReceipt, removeInvoiceReceipt, releaseReceiptImages } from '@bussan/shared';
import type { InvoiceDocumentType, InvoiceReceipt } from '@bussan/shared';

export default function InvoiceReceipts({ staffId, month, approved, onBusyChange, onPrint, onCountChange }: {
  staffId: string; month: string; approved: boolean; onBusyChange: (busy: boolean) => void; onPrint: () => void; onCountChange: (count: number) => void;
}) {
  const [rows, setRows] = useState<InvoiceReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pageChoice, setPageChoice] = useState<0 | 1 | 2>(0);
  const invoiceFiles = useRef<HTMLInputElement>(null);
  const receiptFiles = useRef<HTMLInputElement>(null);
  useEffect(() => { onBusyChange(busy || loading); return () => onBusyChange(false); }, [busy, loading, onBusyChange]);
  useEffect(() => { onCountChange(rows.filter(row => row.document_type !== 'invoice').length); }, [rows, onCountChange]);
  useEffect(() => {
    let active = true; let loaded: InvoiceReceipt[] = [];
    setLoading(true); setRows([]);
    void loadInvoiceReceipts(staffId, month).then(data => { loaded = data; if (active) setRows(data); else releaseReceiptImages(data); })
      .catch(e => { if (active) setError(e.message ?? String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; releaseReceiptImages(loaded); };
  }, [staffId, month, revision]);
  async function upload(selected: FileList | null, documentType: InvoiceDocumentType | 'receipt_upload') {
    if (!selected?.length) return;
    setBusy(true); setError('');
    try {
      for (const file of Array.from(selected)) {
        const type = documentType === 'receipt_upload'
          ? file.type === 'application/pdf' || file.name.toLocaleLowerCase().endsWith('.pdf') ? 'receipt' : 'receipt_photo'
          : documentType;
        await uploadInvoiceReceipt(staffId, month, file, type);
      }
    }
    catch (e) { setError((e as Error).message ?? String(e)); }
    finally { setBusy(false); setRevision(n => n + 1); for (const input of [invoiceFiles.current, receiptFiles.current]) if (input) input.value = ''; }
  }
  async function remove(id: string) {
    setBusy(true); setError('');
    try { await removeInvoiceReceipt(id); } catch (e) { setError((e as Error).message ?? String(e)); }
    finally { setBusy(false); setRevision(n => n + 1); }
  }
  const images = rows.filter(row => row.mime_type.startsWith('image/'));
  const pageCount = pageChoice || (images.length > 6 ? 2 : 1);
  const perPage = Math.ceil(images.length / pageCount);
  const pages = Array.from({ length: Math.min(pageCount, images.length) }, (_, i) => images.slice(i * perPage, (i + 1) * perPage)).filter(page => page.length);
  const labels: Record<InvoiceDocumentType, string> = { invoice: '請求書', receipt: '領収書', receipt_photo: '領収書の写真' };
  const accept = 'image/*,application/pdf,.pdf';
  return <section className="invoice-receipts">
    <div className="receipt-editor no-print"><h3>領収書</h3>
      {!approved && <div className="row">
        <input ref={invoiceFiles} type="file" accept={accept} multiple hidden onChange={e => void upload(e.target.files, 'invoice')} />
        <input ref={receiptFiles} type="file" accept={accept} multiple hidden onChange={e => void upload(e.target.files, 'receipt_upload')} />
        <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => invoiceFiles.current?.click()}>請求書をアップロード（画像・PDF）</button>
        <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => receiptFiles.current?.click()}>領収書をアップロード（画像・PDF）</button>
      </div>}
      {busy && <p role="status">領収書を保存しています…</p>}
      {loading && <p role="status">領収書を読み込み中…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {(['invoice', 'receipt', 'receipt_photo'] as const).map(type => {
        const group = rows.filter(row => row.document_type === type);
        if (!group.length) return null;
        return <section key={type} aria-label={labels[type]}><h4>{labels[type]}</h4><div className="receipt-thumbnails">{group.map((row, i) => <figure key={row.id}>{row.mime_type.startsWith('image/') ? <a href={row.url} target="_blank" rel="noreferrer"><img src={row.url} alt={`${labels[type]} ${i + 1}`} /></a> : <a className="receipt-pdf-link" href={row.url} target="_blank" rel="noreferrer">PDFを開く</a>}<figcaption>{row.original_name}</figcaption>{!approved && <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => void remove(row.id)}>削除</button>}</figure>)}</div></section>;
      })}
      <div className="row"><label>PDFのページ数<select value={pageChoice} onChange={e => setPageChoice(Number(e.target.value) as 0 | 1 | 2)}><option value={0}>自動（1〜2ページ）</option><option value={1}>1ページ</option><option value={2}>2ページ</option></select></label>
        <button type="button" className="btn ghost" disabled={!images.length || loading} onClick={onPrint}>領収書PDF保存・印刷</button>
      </div>
    </div>
    <div className="receipt-document is-preview">{pages.map((page, i) => <article className="receipt-sheet" key={i} style={{ gridTemplateColumns: `repeat(${Math.min(3, page.length)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(page.length / 3)}, minmax(0, 1fr))` }}>{page.map((row, index) => <div key={row.id}><img src={row.url} alt={`領収書 ${i * perPage + index + 1}`} /></div>)}</article>)}</div>
  </section>;
}
