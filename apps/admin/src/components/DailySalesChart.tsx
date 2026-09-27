import { useEffect, useMemo, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchSaleRows } from '../api';
import { recentDailySales, groupProducts } from '../sales';
import type { ProductGroup } from '../sales';

export default function DailySalesChart() {
  const [today, setToday] = useState(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
  const [groups, setGroups] = useState<Map<number, ProductGroup>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const refreshDate = () => setToday(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
    const timer = window.setInterval(refreshDate, 60000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    fetchSaleRows().then(rows => { if (active) setGroups(groupProducts(rows)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const { days, conflicts } = useMemo(() => recentDailySales(groups.values(), today), [groups, today]);
  const period = `${days[0]?.date ?? today} 〜 ${today}`;
  const total = days.reduce((sum, d) => sum + d.amount, 0);
  const peak = Math.max(1, ...days.map(d => d.amount));
  const ceiling = Math.ceil(peak / 4 / 1000) * 4000;
  const point = (i: number) => ({ x: 85 + i * 415 / 6, y: 235 - (days[i]?.amount ?? 0) / ceiling * 190 });
  const active = selected === null ? null : days[selected];
  return <section className="card daily-sales" aria-label="日別売上">
    <div className="toolbar">
      <h3>日別売上（直近7日間）</h3>
    </div>
    {loading ? <p role="status">売上を読み込み中…</p> : error ? <div className="error" role="alert">{error}</div> : <>
      <div className="sales-summary"><strong>{yen(total)}</strong><span>{days.reduce((n, d) => n + d.count, 0)}商品</span></div>
      <p className="sub">{period}</p>
      {conflicts.length > 0 && <div className="error">同じ通番号で販売記録が異なる{conflicts.length}商品は集計に含めていません。元の記録は保持しています。<details><summary>確認が必要な通番号</summary>{conflicts.join('、')}</details></div>}
      <div className="sales-chart-scroll">
        <svg viewBox="0 0 540 280" className="sales-chart" role="group" aria-label={`${period}の日別売上の折れ線グラフ。各日を選択すると金額を表示します。`}>
          {[0, 1, 2, 3, 4].map(t => <g key={t}><line x1={85} x2={500} y1={235 - t * 47.5} y2={235 - t * 47.5} className="chart-grid" /><text x={75} y={240 - t * 47.5} textAnchor="end">{yen(ceiling * t / 4)}</text></g>)}
          <polyline points={days.map((_, i) => { const p = point(i); return `${p.x},${p.y}`; }).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={3} />
          {days.map((d, i) => { const p = point(i); return <g key={d.date}>
            <text x={p.x} y={265} textAnchor="middle">{Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))}</text>
            <circle cx={p.x} cy={p.y} r={selected === i ? 6 : 3} fill="var(--accent)" />
            <circle cx={p.x} cy={p.y} r={12} className="chart-hit" tabIndex={0} role="button" aria-label={`${d.date} 売上 ${yen(d.amount)} ${d.count}商品`}
              onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => setSelected(i)} onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(i); }
              }}><title>{d.date}：{yen(d.amount)}（{d.count}商品）</title></circle>
          </g>; })}
        </svg>
      </div>
      <p className="sales-day" aria-live="polite">{active ? `${active.date}：${yen(active.amount)}（${active.count}商品）` : ''}</p>
      <details><summary>日ごとの金額を表で確認</summary><div className="scroll"><table><thead><tr><th>販売日</th><th className="num">売上</th><th className="num">販売商品数</th></tr></thead><tbody>{days.map(d => <tr key={d.date}><td>{d.date}</td><td className="num">{yen(d.amount)}</td><td className="num">{d.count}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
