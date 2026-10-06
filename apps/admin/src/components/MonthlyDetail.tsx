import ColoredLabel from './ColoredLabel';
import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchMonthlyDetail, type MonthlyDetailItem } from '../api';
import { productSerial } from '../inventory';
import type { ExpenseInput } from '../expenses';
import { ExpenseTable } from './ExpenseList';

export type MonthlyMetric = '仕入数' | '仕入金額' | '販売数' | '売上' | '振込金額' | '粗利益' | '経費' | '純利益' | '平均利益単価';
export default function MonthlyDetail({ month, metric, onClose }: { month: string; metric: MonthlyMetric; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{ items: MonthlyDetailItem[]; expenses: ExpenseInput[] } | null>(null);
  const [error, setError] = useState('');
  const kind = metric.startsWith('仕入') ? 'purchase' : metric === '経費' ? 'expense' : metric === '純利益' ? 'profit' : 'sale';
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    fetchMonthlyDetail(month, kind).then(result => { if (active) setData(result); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [month, kind]);
  const sum = (key: 'cost_amount' | 'sold_price' | 'payout_amount' | 'profit' | 'refund_amount' | 'shipping_cost' | 'other_cost') => (data?.items ?? []).reduce((total, row) => total + (row[key] ?? 0), 0);
  const expenseTotal = (data?.expenses ?? []).reduce((total, row) => total + row.amount, 0);
  const soldCount = new Set((data?.items ?? []).filter(row => !(row.is_accessory && !row.sold_price && !row.payout_amount)).map(row => productSerial(row.sku,row.lot_seq))).size;
  return <dialog ref={dialog} className="monthly-detail" aria-labelledby="monthly-detail-title" onCancel={onClose}>
    <div className="toolbar"><h2 id="monthly-detail-title">{month} · {metric}の内訳</h2><span style={{ flex: 1 }} /><button className="btn" onClick={onClose} autoFocus>閉じる</button></div>
    {error ? <div className="error" role="alert">{error}</div> : !data ? <p>読み込み中…</p> : <>
      {kind === 'purchase' ? <p>{data.items.length}件の仕入 · 合計 {yen(sum('cost_amount'))}</p> : kind === 'expense' ? <p>{data.expenses.length}件 · 経費合計 {yen(expenseTotal)}</p> : <>
        <div className="monthly-detail-totals">
          <span>販売商品数 <strong>{soldCount}点</strong></span><span>売上 <strong>{yen(sum('sold_price'))}</strong></span>
          <span>振込金額 <strong>{yen(sum('payout_amount'))}</strong></span><span>販売商品の仕入金額 <strong>{yen(sum('cost_amount'))}</strong></span>
          <span>返金額 <strong>{yen(sum('refund_amount'))}</strong></span><span>送料・その他費用 <strong>{yen(sum('shipping_cost') + sum('other_cost'))}</strong></span>
          <span>粗利益 <strong>{yen(sum('profit'))}</strong></span><span>平均利益単価 <strong>{soldCount ? yen(Math.round(sum('profit') / soldCount)) : '—'}</strong></span>
          {kind === 'profit' && <><span>経費 <strong>{yen(expenseTotal)}</strong></span><span>純利益 <strong>{yen(sum('profit') - expenseTotal)}</strong></span></>}
        </div>
        <p className="sub">粗利益＝振込金額＋返金額−販売商品の仕入金額−送料・その他費用。平均利益単価＝粗利益÷販売商品数。{kind === 'profit' && '純利益＝粗利益−経費。'}</p>
      </>}
      {kind !== 'expense' && (data.items.length === 0 ? <p>該当する商品はありません。</p> : <div className="scroll"><table>
        <thead><tr><th>通番号</th><th>{kind === 'purchase' ? '仕入日' : '販売日'}</th><th>商品・仕入先</th><th className="num">仕入金額</th>{kind !== 'purchase' && <><th className="num">販売価格</th><th className="num">振込金額</th><th className="num">返金額</th><th className="num">送料・その他</th><th className="num">粗利益</th></>}</tr></thead>
        <tbody>{data.items.map((row, i) => <tr key={row.id}>
          <td>{productSerial(data.items[i - 1]?.sku,data.items[i - 1]?.lot_seq) !== productSerial(row.sku,row.lot_seq) ? productSerial(row.sku,row.lot_seq) : ''}</td><td>{kind === 'purchase' ? row.purchased_at : row.sold_on}</td>
          <td className="detail-description">{row.title}<div className="expense-hint"><ColoredLabel value={row.marketplace || '—'} /></div></td><td className="num">{yen(row.cost_amount)}</td>
          {kind !== 'purchase' && <><td className="num">{yen(row.sold_price)}</td><td className="num">{yen(row.payout_amount)}</td><td className="num">{yen(row.refund_amount)}</td><td className="num">{yen(row.shipping_cost + row.other_cost)}</td><td className="num">{yen(row.profit)}</td></>}
        </tr>)}</tbody>
      </table></div>)}
      {(kind === 'expense' || kind === 'profit') && <><h3>経費明細</h3><ExpenseTable rows={data.expenses} /></>}
    </>}
  </dialog>;
}
