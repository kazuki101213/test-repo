import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import type { DelivererWorkload, MonthlySummary, StockSummary } from '@bussan/shared';
import { fetchMonthly, fetchStockSummary, fetchWorkload, type WorkloadMetric } from '../api';
import DailySalesChart from '../components/DailySalesChart';
import { japanMonth } from '../sales';
import MonthlyDetail, { type MonthlyMetric } from '../components/MonthlyDetail';
import WorkloadDetail from '../components/WorkloadDetail';
import InvoiceTasks from '../components/InvoiceTasks';

const hiddenWorkloadNames = new Set(['長部一輝', '和田知佳', '神谷愛', '株式会社グレイス']);

function Kpi({ label, value, tone, detail, count }: { label: string; value: string; tone?: 'pos' | 'neg'; detail?: string; count?: number }) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
      {count !== undefined && <div className="kpi-value">{count} 点</div>}
      {detail && <details className="kpi-detail"><summary>集計対象</summary>{detail}</details>}
    </div>
  );
}

export default function Dashboard({ isAdmin = false }: { isAdmin?: boolean }) {
  const [expenseRevision, setExpenseRevision] = useState(0);
  const [stock, setStock] = useState<StockSummary | null>(null);
  const [months, setMonths] = useState<MonthlySummary[]>([]);
  const [workload, setWorkload] = useState<DelivererWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ month: string; metric: MonthlyMetric } | null>(null);
  const [workloadDetail, setWorkloadDetail] = useState<{ delivererId: string; name: string; metric: WorkloadMetric } | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([fetchStockSummary(), fetchMonthly(), fetchWorkload()])
      .then(([s, m, w]) => { if (active) { setStock(s); setMonths(m); setWorkload(w); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [expenseRevision]);

  const current = months.find(m => m.month?.startsWith(japanMonth()));
  const visibleMonths = months.filter(m => m.month?.slice(0, 7) <= japanMonth());
  const visibleWorkload = workload.filter(w => !hiddenWorkloadNames.has(w.deliverer_name));

  return (
    <div className="dashboard-workspace">
      <section className="dashboard-content" aria-label="ダッシュボード">
      <div className="toolbar"><h2>ダッシュボード</h2><span style={{ flex: 1 }} />
      </div>
      {error && <div className="error">{error}</div>}

      <div className="grid kpi">
        {isAdmin && <InvoiceTasks onApproved={() => setExpenseRevision(n => n + 1)} />}
        <div className="card sales-summary-card">
          <div className="kpi-label">今月の販売</div>
          <div className="sales-kpi-line"><span>今月の売上</span><strong>{yen(current?.売上)} / {current?.販売数 ?? 0} 点</strong></div>
          <div className="kpi-label" style={{ marginTop: 12 }}>粗利益</div>
          <div className={`kpi-value ${(current?.粗利益 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(current?.粗利益)}</div>
          <div className="kpi-label" style={{ marginTop: 12 }}>純利益</div>
          <div className={`kpi-value ${(current?.純利益 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(current?.純利益)}</div>
          <div className="kpi-label" style={{ marginTop: 12 }}>現在の在庫数 / 作業中</div>
          <div className="kpi-value">{stock?.現在庫数 ?? 0} 点 / {stock?.作業中 ?? 0} 点</div>
        </div>
        <Kpi label="今月の仕入" value={yen(current?.仕入金額)} count={current?.仕入数 ?? 0} />
        <div className="card">
          <div className="kpi-label">在庫の見込み</div>
          <div style={{ marginTop: 10 }}>
            <div className="kpi-label">見込み売上</div>
            <div className="kpi-value">{yen(stock?.売上見込み合計)}</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="kpi-label">見込み利益</div>
            <div className={`kpi-value ${(stock?.見込み利益合計 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(stock?.見込み利益合計)}</div>
          </div>
        </div>
      </div>

      <div className="dashboard-charts">
        <DailySalesChart />
        <div className="card workload-card">
          <h3>納品担当者の稼働</h3>
          {visibleWorkload.length === 0 && <p className="empty">データがありません。</p>}
          <table>
            <thead>
              <tr>
                <th>担当者</th><th className="num">未完了</th>
                <th className="num">今月出荷</th><th className="num">平均作業日数</th>
              </tr>
            </thead>
            <tbody>
              {visibleWorkload.map((w) => (
                <tr key={w.deliverer_id}>
                  <td>
                    {w.deliverer_name}
                  </td>
                  {(['未完了', '今月出荷', '平均作業日数'] as const).map(metric => <td className="num" key={metric}>
                    <button className="metric-link" aria-label={`${w.deliverer_name} ${metric}の詳細`} onClick={() => setWorkloadDetail({ delivererId: w.deliverer_id, name: w.deliverer_name, metric })}>{w[metric] ?? '—'}</button>
                  </td>)}
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
              {visibleMonths.map((m) => (
                <tr key={m.month}>
                  <td>{m.month?.slice(0, 7)}</td>
                  {(['仕入数', '仕入金額', '販売数', '売上', '振込金額', '粗利益', '経費', '純利益', '平均利益単価'] as const).map(metric => (
                    <td className="num" key={metric} style={metric === '純利益' ? { color: m.純利益 >= 0 ? 'var(--ok)' : 'var(--danger)' } : undefined}>
                      <button className="metric-link" aria-label={`${m.month.slice(0, 7)} ${metric}の内訳`} onClick={() => setDetail({ month: m.month.slice(0, 7), metric })}>
                        {metric === '平均利益単価' ? m.販売数 > 0 ? yen(Math.round(m.粗利益 / m.販売数)) : '—' : metric === '仕入数' || metric === '販売数' ? m[metric] : yen(m[metric])}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </section>
      {detail && <MonthlyDetail month={detail.month} metric={detail.metric} onClose={() => setDetail(null)} />}
      {workloadDetail && <WorkloadDetail {...workloadDetail} onClose={() => setWorkloadDetail(null)} />}
    </div>
  );
}
