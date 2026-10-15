import type { InvoiceReceipt } from '@bussan/shared';
export default function ReceiptSheets({ rows, month, name }: { rows: InvoiceReceipt[]; month: string; name: string }) {
  const pages = Array.from({ length: Math.ceil(rows.length / 10) }, (_, i) => rows.slice(i * 10, (i + 1) * 10));
  const images = rows.filter(row => row.mime_type.startsWith('image/'));
  const photos = Array.from({ length: Math.ceil(images.length / 4) }, (_, i) => images.slice(i * 4, (i + 1) * 4));
  return <div className="receipt-document is-preview" aria-label="明細表と添付写真プレビュー">
    {pages.map((page, pageIndex) => <article className="receipt-summary-sheet" key={`details-${pageIndex}`}>
      <h2>領収書明細表</h2><p>{month}　{name}　{pageIndex + 1} / {pages.length}</p>
      <table><thead><tr><th>No.</th><th>日付</th><th>明細名・支払先</th><th>金額（税込）</th></tr></thead><tbody>{page.map((row, i) => <tr key={row.id}><td>{pageIndex * 10 + i + 1}</td><td>{row.spent_on}</td><td>{row.description || row.original_name}{row.payee && <small>{row.payee}</small>}</td><td>{row.amount == null ? '未登録' : `¥${row.amount.toLocaleString('ja-JP')}`}</td></tr>)}</tbody></table>
      {pageIndex === pages.length - 1 && <p className="receipt-summary-total">合計（税込）　¥{rows.reduce((sum, row) => sum + (row.amount ?? 0), 0).toLocaleString('ja-JP')}</p>}
    </article>)}
    {photos.map((page, pageIndex) => <article className="receipt-photo-sheet" key={`photos-${pageIndex}`}>{page.map(row => <figure key={row.id}><figcaption>No.{rows.findIndex(record => record.id === row.id) + 1}　{row.spent_on}　{row.description || row.original_name}</figcaption><img src={row.url} alt={row.description || row.original_name} /></figure>)}</article>)}
  </div>;
}