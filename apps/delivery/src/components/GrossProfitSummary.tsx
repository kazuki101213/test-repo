import { useEffect, useState } from 'react';
import { staffDisplayName } from '@bussan/shared';
import { monthlyGrossProfit, yen } from '../invoices';
import type { MonthlyGrossProfit } from '../invoices';

export default function GrossProfitSummary({ staffId, month }: { staffId: string | null; month: string }) {
  const [summary, setSummary] = useState<MonthlyGrossProfit | null>(null);
  const [loading, setLoading] = useState(!!month);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!month) return;
    let active = true;
    setLoading(true);
    setError('');
    setSummary(null);
    void monthlyGrossProfit(staffId, month).then(data => { if (active) setSummary(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : (cause as { message?: string })?.message ?? '粗利益を読み込めませんでした。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [staffId, month]);

  return <section className="card gross-profit-summary">
    <h3>粗利益</h3>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p>読み込み中…</p> : !error && <>
      <div className="scroll"><table><thead><tr><th>販売日</th><th>SKU</th><th>仕入担当者</th><th>粗利益</th></tr></thead>
        <tbody>{summary?.rows.map(row => <tr key={`${row.sku}/${row.sold_on}`}><td>{row.sold_on}</td><td>{row.sku}</td><td>{staffDisplayName(row.purchaser_name) || '未設定'}</td><td>{yen(row.gross_profit)}</td></tr>)}</tbody>
        <tfoot><tr><th colSpan={3}>月間合計</th><th>{yen(summary?.total ?? 0)}</th></tr></tfoot>
      </table></div>
      {!summary?.rows.length && <p>対象月の販売実績はありません。</p>}
    </>}
  </section>;
}
