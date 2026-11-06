import { useEffect, useState } from 'react';
import type { InvoiceReceipt } from '@bussan/shared';
import { splitInvoicePdfPages } from '@bussan/shared';

export default function InvoiceAttachmentPreview({ file, label }: { file: InvoiceReceipt; label: string }) {
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState('');
  const image = file.mime_type.startsWith('image/');
  useEffect(() => {
    setPages([]); setError('');
    if (image) return;
    const controller = new AbortController();
    const urls: string[] = [];
    void (async () => {
      const response = await fetch(file.url, { signal: controller.signal });
      if (!response.ok) throw new Error('PDFを読み込めません。');
      const bytes = await splitInvoicePdfPages(await response.arrayBuffer());
      if (controller.signal.aborted) return;
      for (const page of bytes) urls.push(URL.createObjectURL(new Blob([new Uint8Array(page).buffer], { type: 'application/pdf' })));
      setPages(urls);
    })().catch(() => { if (!controller.signal.aborted) setError('PDFをページごとに表示できません。元のファイルを開いて確認してください。'); });
    return () => { controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [file.url, image]);
  return <div className="invoice-review-attachments">
    {image ? <section className="invoice-review-page" aria-label={label}><h3>{label}</h3><img className="invoice-review-attachment" src={file.url} alt={file.original_name}/></section> :
      pages.length ? pages.map((url, index) => <section className="invoice-review-page" aria-label={`${label} ${index + 1}ページ`} key={url}><h3>{label}</h3><object className="invoice-review-pdf" data={url} type="application/pdf" aria-label={`${file.original_name} ${index + 1}ページ`}><a href={file.url} target="_blank" rel="noreferrer">{file.original_name}</a></object></section>) :
      <section className="invoice-review-page"><h3>{label}</h3>{error ? <p role="alert">{error} <a href={file.url} target="_blank" rel="noreferrer">{file.original_name}</a></p> : <p role="status">PDFを読み込み中…</p>}</section>}
  </div>;
}
