import type { InvoiceDetails, InvoiceLine, InvoiceSnapshot } from '../invoices';
import { yen } from '../invoices';

type PrintLine = InvoiceLine & { extra?: boolean };
function groupedLines(snapshot: InvoiceSnapshot, extras: InvoiceLine[]): PrintLine[] {
  const grouped = new Map<string, PrintLine>();
  for (const line of snapshot.lines) {
    const description = line.description === 'Amazon返品対応' ? line.description : '納品外注費';
    const key = `${line.date}|${line.unit_price}|${description}`;
    const previous = grouped.get(key);
    if (previous) previous.quantity += line.quantity;
    else grouped.set(key, { ...line, description });
  }
  return [...grouped.values(), ...extras.map(line => ({ ...line, extra: true }))];
}
const money = (value: number) => yen(Number.isFinite(value) ? value : 0);
const shortDate = (date: string | null) => date ? date.slice(5).replace('-', '/') : '';

function Bank({ details: p }: { details: InvoiceDetails }) {
  return <table className="invoice-bank-table"><colgroup><col style={{ width: '20%' }} /><col style={{ width: '30%' }} /><col style={{ width: '22%' }} /><col style={{ width: '28%' }} /></colgroup><tbody>
    <tr><th colSpan={4}>振込先</th></tr>
    <tr><td>銀行名</td><td>{p.bank}</td><td>銀行コード</td><td>{p.bank_code}</td></tr>
    <tr><td>支店名</td><td>{p.branch}</td><td>店番</td><td>{p.branch_code}</td></tr>
    <tr><td>口座種別</td><td>{p.account_type}</td><td>口座番号</td><td>{p.account_number}</td></tr>
    <tr><td>名前</td><td>{p.holder}</td><td>フリガナ</td><td>{p.holder_kana}</td></tr>
  </tbody></table>;
}

export default function InvoiceSheet({ snapshot, month, issued, extras, note }: {
  snapshot: InvoiceSnapshot; month: string; issued: string; extras: InvoiceLine[]; note: string;
}) {
  const p = snapshot.profile;
  const lines = groupedLines(snapshot, extras);
  const subtotal = lines.reduce((sum, l) => sum + (Number.isFinite(l.quantity * l.unit_price) ? l.quantity * l.unit_price : 0), 0);
  const total = subtotal + Math.floor(subtotal * snapshot.tax_percent / 100);
  const quantities = snapshot.lines.reduce((sum, l) => sum + l.quantity, 0);
  const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / 28)) }, (_, i) => lines.slice(i * 28, (i + 1) * 28));
  return <div className="invoice-document" aria-label={`${month}の請求書プレビュー`}>{pages.map((page, pageIndex) => {
    const last = pageIndex === pages.length - 1;
    return <article className="invoice-sheet" key={pageIndex}>
      <div className="invoice-issued">{issued.replaceAll('-', '/')}{pages.length > 1 && `　${pageIndex + 1} / ${pages.length}`}</div>
      <h1>請求書</h1>
      <div className="invoice-parties"><div><div className="invoice-recipient">{p.recipient}</div><p className="invoice-greeting">下記の通り、ご請求申し上げます。</p></div>
        <div className="invoice-issuer"><div><span>住所：</span><span>{p.postal}<br />{p.address}</span></div><div><span>TEL：</span><span>{p.phone}</span></div><div><span>E-Mail：</span><span>{p.email}</span></div><div><span>氏名：</span><span>{p.issuer_name}</span></div></div>
      </div>
      <div className="invoice-total"><span>合計金額</span><strong>{money(total)}</strong></div>
      <table className="invoice-lines"><colgroup><col style={{ width: '12.5%' }} /><col style={{ width: '50%' }} /><col style={{ width: '12.5%' }} /><col style={{ width: '12.5%' }} /><col style={{ width: '12.5%' }} /></colgroup>
        <thead><tr><th>日付</th><th>名称</th><th>数量</th><th>単価（税抜）</th><th>金額（税抜）</th></tr></thead>
        <tbody>{page.map((line, i) => <tr key={i}><td>{shortDate(line.date)}</td><td>{!line.extra && i > 0 && page[i - 1]?.description === line.description ? '〃' : line.description}</td><td>{line.extra && line.quantity === 1 ? '' : Number.isFinite(line.quantity) ? line.quantity : ''}</td><td>{money(line.unit_price)}</td><td>{money(line.quantity * line.unit_price)}</td></tr>)}
          {Array.from({ length: Math.max(0, 24 - page.length) }, (_, i) => <tr key={`blank-${i}`} aria-hidden="true"><td>&nbsp;</td><td /><td /><td /><td /></tr>)}
        </tbody>
        {last && <tfoot><tr><td colSpan={2}>合計</td><td>{quantities}</td><td /><td>{money(total)}</td></tr></tfoot>}
      </table>
      {last && <div className="invoice-footer"><section><div>備考</div><div className="invoice-note">{note || '\u00a0'}</div></section><Bank details={p} /></div>}
    </article>;
  })}</div>;
}
