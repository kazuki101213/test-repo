import { useEffect, useRef, useState } from 'react';
import { loadInvoiceReceipts, uploadInvoiceReceipt, removeInvoiceReceipt, releaseReceiptImages } from '@bussan/shared';
import type { InvoiceReceipt } from '@bussan/shared';

export default function InvoiceReceipts({ staffId, month, approved, onBusyChange, onPrint, onCountChange }: {
  staffId: string; month: string; approved: boolean; onBusyChange: (busy: boolean) => void; onPrint: () => void; onCountChange: (count: number) => void;
}) {
  const [rows, setRows] = useState<InvoiceReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pageChoice, setPageChoice] = useState<0 | 1 | 2>(0);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useEffect(() => { onBusyChange(busy || loading); return () => onBusyChange(false); }, [busy, loading, onBusyChange]);
  useEffect(() => { onCountChange(rows.length); }, [rows.length, onCountChange]);
  useEffect(() => {
    let active = true; let loaded: InvoiceReceipt[] = [];
    setLoading(true); setRows([]);
    void loadInvoiceReceipts(staffId, month).then(data => { loaded = data; if (active) setRows(data); else releaseReceiptImages(data); })
      .catch(e => { if (active) setError(e.message ?? String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; releaseReceiptImages(loaded); };
  }, [staffId, month, revision]);
  async function upload(selected: FileList | null) {
    if (!selected?.length) return;
    setBusy(true); setError('');
    try { for (const file of Array.from(selected)) await uploadInvoiceReceipt(staffId, month, file); }
    catch (e) { setError((e as Error).message ?? String(e)); }
    finally { setBusy(false); setRevision(n => n + 1); if (camera.current) camera.current.value = ''; if (files.current) files.current.value = ''; }
  }
  async function remove(id: string) {
    setBusy(true); setError('');
    try { await removeInvoiceReceipt(id); } catch (e) { setError((e as Error).message ?? String(e)); }
    finally { setBusy(false); setRevision(n => n + 1); }
  }
  const pageCount = pageChoice || (rows.length > 6 ? 2 : 1);
  const perPage = Math.ceil(rows.length / pageCount);
  const pages = Array.from({ length: Math.min(pageCount, rows.length) }, (_, i) => rows.slice(i * perPage, (i + 1) * perPage)).filter(page => page.length);
  return <section className="invoice-receipts">
    <div className="receipt-editor no-print"><h3>領収書</h3>
      {!approved && <div className="row">
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => void upload(e.target.files)} />
        <input ref={files} type="file" accept="image/*" multiple hidden onChange={e => void upload(e.target.files)} />
        <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => files.current?.click()}>画像アップロード</button>
        <button type="button" className="btn ghost receipt-camera-btn" aria-label="カメラで領収書を撮影" title="カメラで領収書を撮影" disabled={busy || loading} onClick={() => camera.current?.click()}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7.5h3l1.8-2.5h8.4L18 7.5h3v11H3z" /><circle cx="12" cy="13" r="3.5" /></svg>
        </button>
      </div>}
      {busy && <p role="status">領収書を保存しています…</p>}
      {loading && <p role="status">領収書を読み込み中…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="receipt-thumbnails">{rows.map((row, i) => <figure key={row.id}><img src={row.url} alt={`領収書 ${i + 1}`} /><figcaption>{i + 1}. {row.original_name}</figcaption>{!approved && <button type="button" className="btn ghost" disabled={busy || loading} onClick={() => void remove(row.id)}>削除</button>}</figure>)}</div>
      <div className="row"><label>PDFのページ数<select value={pageChoice} onChange={e => setPageChoice(Number(e.target.value) as 0 | 1 | 2)}><option value={0}>自動（1〜2ページ）</option><option value={1}>1ページ</option><option value={2}>2ページ</option></select></label>
        <button type="button" className="btn ghost" disabled={!rows.length || loading} onClick={onPrint}>領収書PDF保存・印刷</button>
      </div>
    </div>
    <div className="receipt-document is-preview">{pages.map((page, i) => <article className="receipt-sheet" key={i} style={{ gridTemplateColumns: `repeat(${Math.min(3, page.length)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(page.length / 3)}, minmax(0, 1fr))` }}>{page.map((row, index) => <div key={row.id}><img src={row.url} alt={`領収書 ${i * perPage + index + 1}`} /></div>)}</article>)}</div>
  </section>;
}
