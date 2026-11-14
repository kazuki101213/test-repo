import { staffDisplayName, yen, type Staff } from '@bussan/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { fetchDashboardPurchaserSummary, fetchMonthly, fetchStockSummary, fetchWorkload, workloadMetrics } from '../api';
import type { DashboardMonth, DashboardPurchaserSummary, DashboardScope, DashboardStock, DelivererWorkload, WorkloadMetric } from '../api';
import DailySalesChart from '../components/DailySalesChart';
import { japanMonth } from '../sales';
import MonthlyDetail, { type MonthlyMetric } from '../components/MonthlyDetail';
import WorkloadDetail from '../components/WorkloadDetail';
import InvoiceTasks from '../components/InvoiceTasks';
import MalfunctionTasks from '../components/MalfunctionTasks';
import SpareShippingTasks from '../components/SpareShippingTasks';
import PushSettings from '../components/PushSettings';

const hiddenWorkloadNames = new Set(['長部一輝', '和田知佳', '神谷愛', '株式会社グレイス', '石川秀樹']);
const monthlyMetrics = ['仕入数', '仕入金額', '販売数', '売上', '振込金額', '粗利益', '経費', '純利益', '平均利益単価'] as const;
const scopes = ['all', 'mine'] as const;

function MetricPair({ children }: { children: (scope: DashboardScope) => ReactNode }) {
  return <span className="dashboard-metric-pair">
    {children('all')}<span className="dashboard-metric-divider"> / </span>{children('mine')}
  </span>;
}

function formatMonthlyMetric(metric: MonthlyMetric, month?: DashboardMonth) {
  if (metric === '平均利益単価') return month?.販売数 ? yen(Math.round(month.粗利益 / month.販売数)) : '—';
  if (metric === '仕入数' || metric === '販売数') return month?.[metric] ?? 0;
  return yen(month?.[metric]);
}

export default function Dashboard({ staff, userId }: { staff: Staff; userId: string }) {
  const isAdmin = staff.role === 'admin';
  const [expenseRevision, setExpenseRevision] = useState(0);
  const [stock, setStock] = useState<DashboardStock | null>(null);
  const [months, setMonths] = useState<DashboardMonth[]>([]);
  const [mine, setMine] = useState<DashboardPurchaserSummary | null>(null);
  const [workload, setWorkload] = useState<DelivererWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ month: string; metric: MonthlyMetric; scope: DashboardScope } | null>(null);
  const [workloadDetail, setWorkloadDetail] = useState<{ delivererId: string; name: string; metric: WorkloadMetric; scope: DashboardScope } | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([fetchStockSummary(), fetchMonthly(), fetchWorkload(), fetchDashboardPurchaserSummary()])
      .then(([s, m, w, purchaser]) => {
        if (active) {
          setStock(s);
          setMonths(m);
          setWorkload(w);
          setMine(purchaser);
        }
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [expenseRevision, staff.id]);

  const thisMonth = japanMonth();
  const mineByMonth = new Map(mine?.months.map(row => [row.month, row]));
  const mineByDeliverer = new Map(mine?.workload.map(row => [row.deliverer_id, row]));
  const visibleMonths = months.filter(row => row.month?.slice(0, 7) <= thisMonth);
  const visibleWorkload = workload.filter(row => !hiddenWorkloadNames.has(row.deliverer_name));
  const scopeNames = { all: '全体', mine: staffDisplayName(staff) };
  const comparisonLabel = `${scopeNames.all} / ${scopeNames.mine}`;
  const summaries = scopes.map(scope => ({
    scope,
    name: scopeNames[scope],
    month: (scope === 'all' ? months : mine?.months)?.find(row => row.month?.startsWith(thisMonth)),
    stock: scope === 'all' ? stock : mine?.stock,
  }));

  return (
    <div className="dashboard-workspace">
      <section className={`dashboard-content${isAdmin ? ' management-dashboard' : ''}`} aria-label="ダッシュボード">
        {error && <div className="error" role="alert">{error}</div>}

        <div className={`grid kpi dashboard-kpis${isAdmin ? ' management-kpis' : ''}`}>
          {isAdmin && <InvoiceTasks staff={staff} onApproved={() => setExpenseRevision(n => n + 1)} />}
          <div className="card sales-summary-card">
            <h3>今月販売</h3>
            <div className="dashboard-comparison">
              {summaries.map(({ scope, name, month, stock: inventory }) => <div className="dashboard-comparison-panel" key={scope}>
                <h4>{name}</h4>
                <div className="kpi-label">売上</div>
                <div className="kpi-value">{yen(month?.売上)} <span className="dashboard-kpi-count">{month?.販売数 ?? 0} 点</span></div>
                <div className="kpi-label">粗利益</div>
                <div className={`kpi-value ${(month?.粗利益 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(month?.粗利益)}</div>
                <div className="kpi-label">純利益</div>
                <div className={`kpi-value ${(month?.純利益 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(month?.純利益)}</div>
                <div className="kpi-label">保有在庫</div>
                <div className="kpi-value">{inventory?.現在庫数 ?? 0} 点</div>
              </div>)}
            </div>
          </div>
          <div className="card purchase-summary-card">
            <h3>今月仕入</h3>
            <div className="dashboard-comparison">
              {summaries.map(({ scope, name, month }) => <div className="dashboard-comparison-panel" key={scope}>
                <h4>{name}</h4>
                <div className="kpi-value">{yen(month?.仕入金額)} <span className="dashboard-kpi-count">{month?.仕入数 ?? 0} 点</span></div>
              </div>)}
            </div>
          </div>
          <div className="card stock-summary-card">
            <h3>在庫見込</h3>
            <div className="dashboard-comparison">
              {summaries.map(({ scope, name, stock: inventory }) => <div className="dashboard-comparison-panel" key={scope}>
                <h4>{name}</h4>
                <div className="kpi-label">見込み売上</div>
                <div className="kpi-value">{yen(inventory?.売上見込み合計)}</div>
                <div className="kpi-label">見込み利益</div>
                <div className={`kpi-value ${(inventory?.見込み利益合計 ?? 0) >= 0 ? 'pos' : 'neg'}`}>{yen(inventory?.見込み利益合計)}</div>
              </div>)}
            </div>
          </div>
        </div>

        {staff.role === 'purchaser' && <section className="card" style={{ marginTop: 16 }} aria-label="動作不良の報告">
          <h3>動作不良の報告</h3>
          <p className="muted">納品担当者から届いた報告です。返信は納品アプリの商品詳細のコメント欄に表示されます。</p>
          <ul className="invoice-task-rows"><MalfunctionTasks staff={staff} /><SpareShippingTasks staff={staff} management /></ul>
        </section>}

        <div className="dashboard-charts">
          <DailySalesChart key={staff.id} purchaserName={scopeNames.mine} />
          <div className="card workload-card">
            <h3>納品担当者の稼働</h3>
            <p className="dashboard-scope-legend">{comparisonLabel}</p>
            {visibleWorkload.length === 0 && <p className="empty">データがありません。</p>}
            <div className="scroll workload-table" tabIndex={0} role="region" aria-label="納品担当者別の在庫"><table>
              <thead>
                <tr>
                  <th scope="col">納品担当者</th>
                  {workloadMetrics.map(metric => <th scope="col" className="num" key={metric.key}>{metric.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleWorkload.map(row => (
                  <tr key={row.deliverer_id}>
                    <th scope="row">{staffDisplayName(row.deliverer_name)}</th>
                    {workloadMetrics.map(metric => <td className={`num${metric.key === 'on_hand' || metric.key === 'listed_on_hand' ? ' workload-emphasis' : ''}`} key={metric.key}>
                      <MetricPair>{scope => {
                        const count = scope === 'all' ? row[metric.key] : mineByDeliverer.get(row.deliverer_id)?.[metric.key] ?? 0;
                        const name = staffDisplayName(row.deliverer_name);
                        return count > 0 ? <button className="metric-link"
                          aria-label={`${name} ${metric.label} ${scopeNames[scope]} ${count}点の詳細`}
                          onClick={() => setWorkloadDetail({ delivererId: row.deliverer_id, name, metric, scope })}>{count}</button> : '0';
                      }}</MetricPair>
                    </td>)}
                  </tr>
                ))}
              </tbody>
              {visibleWorkload.length > 0 && <tfoot><tr><th scope="row">合計</th>
                {workloadMetrics.map(metric => <td className="num" key={metric.key}>
                  <MetricPair>{scope => visibleWorkload.reduce((sum, row) => sum +
                    (scope === 'all' ? row[metric.key] : mineByDeliverer.get(row.deliverer_id)?.[metric.key] ?? 0), 0)}</MetricPair>
                </td>)}
              </tr></tfoot>}
            </table></div>
          </div>
        </div>

        <div className="card monthly-trend-card" style={{ marginTop: 16 }}>
          <h3>月次推移</h3>
          <p className="dashboard-scope-legend">{comparisonLabel}</p>
          <div className="scroll" style={{ maxHeight: '40vh', border: 0 }}>
            <table>
              <thead><tr><th scope="col">月</th>{monthlyMetrics.map(metric =>
                <th key={metric} scope="col" className="num" title={metric === '平均利益単価' ? '粗利益 ÷ 販売商品数（同じ通番号は1商品）' : undefined}>{metric}</th>)}</tr></thead>
              <tbody>
                {visibleMonths.map(row => {
                  const monthLabel = row.month.slice(0, 7);
                  return <tr key={row.month}>
                    <th scope="row">{monthLabel}</th>
                    {monthlyMetrics.map(metric => <td className="num" key={metric}>
                      <MetricPair>{scope => {
                        const month = scope === 'all' ? row : mineByMonth.get(row.month);
                        const color = metric === '純利益' ? ((month?.純利益 ?? 0) >= 0 ? 'var(--ok)' : 'var(--danger)') : undefined;
                        return <button className="metric-link" style={{ color }} aria-label={`${monthLabel} ${metric} ${scopeNames[scope]}の内訳`}
                          onClick={() => setDetail({ month: monthLabel, metric, scope })}>{formatMonthlyMetric(metric, month)}</button>;
                      }}</MetricPair>
                    </td>)}
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <div className="dashboard-notification-settings"><PushSettings key={userId} userId={userId} /></div>
      {detail && <MonthlyDetail {...detail} scopeLabel={scopeNames[detail.scope]} onClose={() => setDetail(null)} />}
      {workloadDetail && <WorkloadDetail {...workloadDetail} scopeLabel={scopeNames[workloadDetail.scope]} onClose={() => setWorkloadDetail(null)} />}
    </div>
  );
}
