import type { InvoiceReceipt } from '@bussan/shared';
export default function ReceiptSheets({ rows, month, name }: { rows: InvoiceReceipt[]; month: string; name: string }) {
  const pages: InvoiceReceipt[][] = []; let used = 0;
  for (const row of rows) {
    const units = Math.max(1, Math.ceil((row.description || row.original_name).length / 28)) + Math.ceil((row.payee ?? '').length / 28);
    if (!pages.length || used + units > 26 || pages[pages.length - 1]!.length >= 10) { pages.push([]); used = 0; }
    pages[pages.length - 1]!.push(row); used += units;
  }
  const images = rows.filter(row => row.mime_type.startsWith('image/'));
  const photos = Array.from({ length: Math.ceil(images.length / 4) }, (_, i) => images.slice(i * 4, (i + 1) * 4));
  return <div className="receipt-document is-preview" aria-label="明細表と添付写真プレビュー">
    {pages.map((page, pageIndex) => <article className="receipt-summary-sheet" key={`details-${pageIndex}`}>
      <header className="document-heading"><h2>領収書明細書</h2></header><div className="receipt-summary-meta"><span>{month}　{name}</span><span>{pageIndex + 1} / {pages.length}</span></div>
      <table><thead><tr><th>No.</th><th>日付</th><th>明細</th><th>金額（円）</th></tr></thead><tbody>{page.map(row => <tr key={row.id}><td>{rows.findIndex(record => record.id === row.id) + 1}</td><td>{row.spent_on}</td><td>{row.description || row.original_name}{row.payee && <>　{row.payee}</>}</td><td>{row.amount == null ? '未登録' : `¥${row.amount.toLocaleString('ja-JP')}`}</td></tr>)}</tbody></table>
      {pageIndex === pages.length - 1 && <p className="receipt-summary-total">合計（税込）　¥{rows.reduce((sum, row) => sum + (row.amount ?? 0), 0).toLocaleString('ja-JP')}</p>}
    </article>)}
    {photos.map((page, pageIndex) => <article className="receipt-photo-sheet" key={`photos-${pageIndex}`}>{page.map(row => <figure key={row.id}><figcaption>No.{rows.findIndex(record => record.id === row.id) + 1}　{row.spent_on}　{row.description || row.original_name}</figcaption><img src={row.url} alt={row.description || row.original_name} /></figure>)}</article>)}
  </div>;
}