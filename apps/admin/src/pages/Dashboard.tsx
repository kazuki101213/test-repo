import { useEffect, useState } from 'react';
import { yen, errorMessage } from '@bussan/shared';
import type { DelivererWorkload, MonthlySummary, StockSummary } from '@bussan/shared';
import { fetchMonthly, fetchStockSummary, fetchWorkload } from '../api';

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const [stock, setStock] = useState<StockSummary | null>(null);
  const [months, setMonths] = useState<MonthlySummary[]>([]);
  const [workload, setWorkload] = useState<DelivererWorkload[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchStockSummary(), fetchMonthly(12), fetchWorkload()])
      .then(([s, m, w]) => { setStock(s); setMonths(m); setWorkload(w); })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const current = months[0];
  const maxWork = Math.max(1, ...workload.map((w) => w.未完了));

  return (
    <>
      <h2>ダッシュボード</h2>
      <p className="sub">在庫と今月の数字。総合管理表の集計シートに対応します。</p>
      {error && <div className="error">{error}</div>}

      <div className="grid kpi">
        <Kpi label="現在庫数" value={`${stock?.現在庫数 ?? 0} 点`} />
        <Kpi label="在庫の仕入金額" value={yen(stock?.仕入金額合計)} />
        <Kpi label="在庫の売上見込み" value={yen(stock?.売上見込み合計)} />
        <Kpi label="在庫の見込み利益" value={yen(stock?.見込み利益合計)} tone="pos" />
        <Kpi label="今月の仕入" value={`${current?.仕入数 ?? 0} 点 / ${yen(current?.仕入金額)}`} />
        <Kpi label="今月の販売" value={`${current?.販売数 ?? 0} 点 / ${yen(current?.売上)}`} />
        <Kpi
          label="今月の純利益"
          value={yen(current?.純利益)}
          tone={(current?.純利益 ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <Kpi label="作業中 / 入荷待ち" value={`${stock?.作業中 ?? 0} / ${stock?.入荷待ち ?? 0}`} />
      </div>

      <div className="grid cols2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>出品の状況</h3>
          <table>
            <tbody>
              <tr><td>出品数（写真登録まで完了・未販売）</td><td className="num">{stock?.出品数 ?? 0} 点</td></tr>
              <tr><td>これから出品（写真がまだ）</td><td className="num">{stock?.これから出品 ?? 0} 点</td></tr>
              <tr><td>返品処理（仕入先へ返品）</td><td className="num">{stock?.返品処理 ?? 0} 点</td></tr>
              <tr><td>Amazon返品（再作業が必要）</td><td className="num">{stock?.Amazon返品 ?? 0} 点</td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
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
                    <div className="bar" style={{ marginTop: 4 }}>
                      <span style={{ width: `${(w.未完了 / maxWork) * 100}%` }} />
                    </div>
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
                <th className="num">平均回転日数</th>
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
                  <td className="num">{m.平均回転日数 ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
