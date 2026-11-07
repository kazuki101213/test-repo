import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoicePageEnds } from '../invoicePagination';
import type { InvoiceReceipt } from '@bussan/shared';
import type { InvoiceDetails, InvoiceLine, InvoiceSnapshot } from '../invoices';
import { yen } from '../invoices';

type PrintLine = InvoiceLine & { extra?: boolean; taxIncluded?: boolean };
export function groupedInvoiceLines(snapshot: InvoiceSnapshot, extras: InvoiceLine[]): PrintLine[] {
  if (snapshot.review_edited) return [...snapshot.lines.map(line => ({...line})), ...extras.map(line => ({...line,extra:true}))];
  const grouped = new Map<string, { line: PrintLine; serials: string[] }>();
  for (const line of snapshot.lines) {
    const description = line.description === 'Amazon返品対応' ? line.description : '納品外注費';
    const key = `${line.date}|${line.unit_price}|${description}`;
    const serial = line.serial?.trim() || (line.lot_seq != null ? String(line.lot_seq) : '');
    const previous = grouped.get(key);
    if (previous) {
      previous.line.quantity += line.quantity;
      if (serial) previous.serials.push(serial);
    } else grouped.set(key, { line: { ...line, description }, serials: serial ? [serial] : [] });
  }
  return [...grouped.values()].map(({ line, serials }) => ({
    ...line, description: serials.length ? `${line.description}(${serials.join('、')})` : line.description,
  })).concat(extras.map(line => ({ ...line, extra: true })));
}
const money = (value: number) => yen(Number.isFinite(value) ? value : 0);
const shortDate = (date: string | null) => date ? date.slice(5).replace('-', '/') : '';

function bankValue(value: string) {
  return <td><span className="invoice-bank-value"><span>{value}</span></span></td>;
}

function Bank({ details: p }: { details: InvoiceDetails }) {
  return <table className="invoice-bank-table"><colgroup><col style={{ width: '12%' }} /><col style={{ width: '37%' }} /><col style={{ width: '14%' }} /><col style={{ width: '37%' }} /></colgroup><tbody>
    <tr><th colSpan={4}>振込先</th></tr>
    <tr><td>銀行名</td>{bankValue(p.bank)}<td>銀行コード</td>{bankValue(p.bank_code)}</tr>
    <tr><td>支店名</td>{bankValue(p.branch)}<td>店番</td>{bankValue(p.branch_code)}</tr>
    <tr><td>口座種別</td>{bankValue(p.account_type)}<td>口座番号</td>{bankValue(p.account_number)}</tr>
    <tr><td>名前</td>{bankValue(p.holder)}<td>フリガナ</td>{bankValue(p.holder_kana)}</tr>
  </tbody></table>;
}

export default function InvoiceSheet({ snapshot, month, issued, extras, note, receipts = [], renderPage }: {
  snapshot: InvoiceSnapshot; month: string; issued: string; extras: InvoiceLine[]; note: string; receipts?: InvoiceReceipt[]; renderPage?: (page: ReactNode, index: number) => ReactNode;
}) {
  const p = snapshot.profile;
  const lines: PrintLine[] = [
    ...groupedInvoiceLines(snapshot, []),
    ...receipts.map(row => ({ date: row.spent_on ?? null, description: (row.description ?? '') + '（税込）', quantity: 1, unit_price: row.amount ?? 0, extra: true, taxIncluded: true })),
    ...extras.map(line => ({ ...line, extra: true })),
  ];
  const subtotal = lines.filter(line => !line.taxIncluded).reduce((sum, l) => sum + (Number.isFinite(l.quantity * l.unit_price) ? l.quantity * l.unit_price : 0), 0);
  const workFees = snapshot.lines.reduce((sum, line) => sum + (Number.isFinite(line.quantity * line.unit_price) ? line.quantity * line.unit_price : 0), 0);
  const allowances = subtotal - workFees;
  const reimbursement = receipts.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const total = subtotal + Math.floor(subtotal * snapshot.tax_percent / 100) + reimbursement;
  const quantities = snapshot.lines.reduce((sum, l) => sum + l.quantity, 0);
  // Long descriptions consume more space while keeping every item on the PDF.
  const rowUnits = (line: PrintLine) => Math.max(1, Math.ceil(Array.from(line.description).reduce((width, char) => width + (/[^\x00-\x7f]/.test(char) ? 1 : .55), 0) / 28));
  const root = useRef<HTMLDivElement>(null);
  const [measuredEnds, setMeasuredEnds] = useState<number[] | null>(null);
  const ends = measuredEnds ?? invoicePageEnds(lines.map(line => rowUnits(line) * 22), 720, 900, 200);
  const pageEnds = [...ends.filter(end => end > 0 && end < lines.length), lines.length];
  const pages = pageEnds.map((end, index) => lines.slice(index ? pageEnds[index - 1]! : 0, end));
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let active = true;
    const height = (node: Element | null) => {
      if (!(node instanceof HTMLElement)) return 0;
      const css = getComputedStyle(node);
      return node.offsetHeight + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    };
    const measure = () => {
      if (!active) return;
      const first = element.querySelector<HTMLElement>('.invoice-sheet');
      if (!first || !first.offsetWidth) return;
      for (const cell of element.querySelectorAll<HTMLElement>('.invoice-bank-value')) {
        const text = cell.firstElementChild as HTMLElement;
        const width = text.offsetWidth;
        text.style.transform = width > cell.clientWidth ? `scaleX(${cell.clientWidth / width})` : '';
      }
      const css = getComputedStyle(first);
      const usable = first.offsetWidth * 270 / 190 - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) - 4;
      const heading = height(first.querySelector('.document-heading'));
      const continuationDate = height(element.querySelector('.invoice-continuation-issued'));
      const header = heading + height(first.querySelector('.invoice-parties')) + height(first.querySelector('.invoice-total'));
      const tableHead = height(first.querySelector('thead'));
      const footer = height(element.querySelector('tfoot')) + height(element.querySelector('.invoice-reimbursement')) + height(element.querySelector('.invoice-footer'));
      const rows = Array.from(element.querySelectorAll<HTMLElement>('.invoice-lines > tbody > tr'), row => row.offsetHeight);
      if (rows.length !== lines.length) return;
      const next = invoicePageEnds(rows, usable - header - tableHead, usable - heading - continuationDate - tableHead, footer);
      setMeasuredEnds(current => current?.join(',') === next.join(',') ? current : next);
    };
    measure();
    void document.fonts.ready.then(measure);
    return () => { active = false; };
  });
  return <div ref={root} className="invoice-document" aria-label={`${month}の請求書プレビュー`}>{pages.map((page, pageIndex) => {
    const last = pageIndex === pages.length - 1;
    const issuedLabel = issued.replaceAll('-', '/') + (pages.length > 1 ? `　${pageIndex + 1} / ${pages.length}` : '');
    const pageContent = <article className="invoice-sheet" key={pageIndex}>
      <header className="document-heading"><h1>請求書</h1></header>
      {pageIndex > 0 && <div className="invoice-issued invoice-continuation-issued">{issuedLabel}</div>}
      {pageIndex === 0 && <><div className="invoice-parties"><div><div className="invoice-recipient">{p.recipient}</div><p className="invoice-greeting">下記の通り、ご請求申し上げます。</p></div>
        <div className="invoice-issuer"><div className="invoice-issued">{issuedLabel}</div><div><span>氏名：</span><span>{p.issuer_name}</span></div><div><span>住所：</span><span>{p.postal}<br />{p.address}</span></div><div><span>TEL：</span><span>{p.phone}</span></div><div><span>E-Mail：</span><span>{p.email}</span></div></div>
      </div>
      <div className="invoice-total"><span>合計金額</span><strong>{money(total)}</strong></div></>}
      <table className="invoice-lines"><colgroup><col style={{ width: '12.5%' }} /><col style={{ width: '50%' }} /><col style={{ width: '12.5%' }} /><col style={{ width: '12.5%' }} /><col style={{ width: '12.5%' }} /></colgroup>
        <thead><tr><th>日付</th><th>内容</th><th>数量</th><th>単価（円）</th><th>金額（円）</th></tr></thead>
        <tbody>{page.map((line, i) => <tr key={i}><td>{shortDate(line.date)}</td><td>{line.description}</td><td>{line.extra && line.quantity === 1 ? '' : Number.isFinite(line.quantity) ? line.quantity : ''}</td><td>{money(line.unit_price)}</td><td>{money(line.quantity * line.unit_price)}</td></tr>)}
        </tbody>
        {last && <tfoot><tr><td colSpan={2}>合計</td><td>{quantities}</td><td /><td>{money(total)}</td></tr></tfoot>}
      </table>
      {last && <div className="invoice-reimbursement"><p>作業費：{money(workFees)}</p><p>手当：{money(allowances)}</p><p>消費税：{money(Math.floor(subtotal * snapshot.tax_percent / 100))}</p><p>立替経費（税込）：{money(reimbursement)}</p></div>}
      {last && <div className="invoice-footer"><section><div>備考</div><div className="invoice-note">{note || '\u00a0'}</div></section><Bank details={p} /></div>}
    </article>;
    return renderPage ? renderPage(pageContent, pageIndex) : pageContent;
  })}</div>;
}
