import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import type { DelivererWorkload, MonthlySummary, StockSummary } from '@bussan/shared';
import { fetchMonthly, fetchStockSummary, fetchWorkload } from '../api';
import DailySalesChart from '../components/DailySalesChart';
import { japanMonth } from '../sales';
import ExpensePanel from '../components/ExpensePanel';

function Kpi({ label, value, tone, detail }: { label: string; value: string; tone?: 'pos' | 'neg'; detail?: string }) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      {detail && <details className="kpi-detail"><summary>集計対象</summary>{detail}</details>}
    </div>
  );
}

export default function Dashboard({ canManageExpenses }: { canManageExpenses: boolean }) {
  const [stock, setStock] = useState<StockSummary | null>(null);
  const [months, setMonths] = useState<MonthlySummary[]>([]);
  const [workload, setWorkload] = useState<DelivererWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([fetchStockSummary(), fetchMonthly(), fetchWorkload()])
      .then(([s, m, w]) => { if (active) { setStock(s); setMonths(m); setWorkload(w); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [revision]);

  const current = months.find(m => m.month?.startsWith(japanMonth()));

  return (
    <div className={`dashboard-workspace${expenseOpen ? ' with-expense' : ''}`}>
      <section className="dashboard-content" aria-label="ダッシュボード">
      <div className="toolbar"><h2>ダッシュボード</h2><span style={{ flex: 1 }} />
        {canManageExpenses && <button className="btn" aria-expanded={expenseOpen} aria-controls="expense-panel" disabled={expenseBusy} onClick={() => setExpenseOpen(open => !open)}>{expenseOpen ? '経費入力を閉じる' : '経費を入力'}</button>}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="grid kpi">
        <Kpi label="現在庫数" value={`${stock?.現在庫数 ?? 0} 点`} detail="在庫一覧から販売済・返品処理・廃棄を除外。同じ通番号は1点として集計します。Amazon返品は含みます。" />
        <Kpi label="在庫の仕入金額" value={yen(stock?.仕入金額合計)} />
        <Kpi label="在庫の売上見込み" value={yen(stock?.売上見込み合計)} />
        <Kpi label="在庫の見込み利益" value={yen(stock?.見込み利益合計)} tone="pos" />
        <Kpi label="今月の仕入" value={`${current?.仕入数 ?? 0} 点 / ${yen(current?.仕入金額)}`} />
        <Kpi label="今月の販売" value={`${current?.販売数 ?? 0} 点 / ${yen(current?.売上)}`} />
        <Kpi label="今月の経費" value={yen(current?.経費)} />
        <Kpi
          label="今月の純利益"
          value={yen(current?.純利益)}
          tone={(current?.純利益 ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <Kpi label="作業中 / 入荷待ち" value={`${stock?.作業中 ?? 0} / ${stock?.入荷待ち ?? 0}`} />
      </div>

      <div className="dashboard-charts">
        <DailySalesChart />
        <div className="card workload-card">
          <h3>納品担当者の稼働</h3>
          {workload.length === 0 && <p className="empty">データがありません。</p>}
          <table>
            <thead>
              <tr>
                <th>担当者</th><th className="num">未完了</th>
                <th className="num">今月出荷</th><th className="num">平均作業日数</th>
              </tr>
            </thead>
            <tbody>
              {workload.map((w) => (
                <tr key={w.deliverer_id}>
                  <td>
                    {w.deliverer_name}
                  </td>
                  <td className="num">{w.未完了}</td>
                  <td className="num">{w.今月出荷}</td>
                  <td className="num">{w.平均作業日数 ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>月次推移</h3>
        <div className="scroll" style={{ maxHeight: '40vh', border: 0 }}>
          <table>
            <thead>
              <tr>
                <th>月</th>
                <th className="num">仕入数</th><th className="num">仕入金額</th>
                <th className="num">販売数</th><th className="num">売上</th>
                <th className="num">振込金額</th><th className="num">粗利益</th>
                <th className="num">経費</th><th className="num">純利益</th>
                <th className="num" title="粗利益 ÷ 販売商品数（同じ通番号は1商品）">平均利益単価</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month?.slice(0, 7)}</td>
                  <td className="num">{m.仕入数}</td>
                  <td className="num">{yen(m.仕入金額)}</td>
                  <td className="num">{m.販売数}</td>
                  <td className="num">{yen(m.売上)}</td>
                  <td className="num">{yen(m.振込金額)}</td>
                  <td className="num">{yen(m.粗利益)}</td>
                  <td className="num">{yen(m.経費)}</td>
                  <td className="num" style={{ color: m.純利益 >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                    {yen(m.純利益)}
                  </td>
                  <td className="num">{m.販売数 > 0 ? yen(Math.round(m.粗利益 / m.販売数)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </section>
      {canManageExpenses && expenseOpen && <ExpensePanel onClose={() => setExpenseOpen(false)} onSaved={() => setRevision(v => v + 1)} onBusyChange={setExpenseBusy} />}
    </div>
  );
}
