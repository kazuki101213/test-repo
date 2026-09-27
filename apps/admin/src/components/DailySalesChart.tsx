import { useEffect, useMemo, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchSaleRows } from '../api';
import { dailySales, groupProducts, japanMonth } from '../sales';
import type { ProductGroup } from '../sales';

export default function DailySalesChart() {
  const [month, setMonth] = useState(japanMonth);
  const [groups, setGroups] = useState<Map<number, ProductGroup>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    fetchSaleRows().then(rows => { if (active) setGroups(groupProducts(rows)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const { days, conflicts } = useMemo(() => dailySales(groups.values(), month), [groups, month]);
  const total = days.reduce((sum, d) => sum + d.amount, 0);
  const peak = Math.max(1, ...days.map(d => d.amount));
  const ceiling = Math.ceil(peak / 4 / 1000) * 4000;
  const point = (i: number) => ({ x: 80 + i * 860 / Math.max(1, days.length - 1), y: 260 - (days[i]?.amount ?? 0) / ceiling * 220 });
  const active = selected === null ? null : days[selected];
  function shift(delta: number) {
    const year = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    setMonth(new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7)); setSelected(null);
  }
  return <section className="card daily-sales" aria-label="日別売上">
    <div className="toolbar">
      <h3>日別売上</h3>
      <span style={{ flex: 1 }} />
      <button className="btn" aria-label="前月の売上" onClick={() => shift(-1)}>前月</button>
      <label className="field"><span>売上を表示する月</span><input type="month" value={month} onChange={e => {
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) { setMonth(e.target.value); setSelected(null); }
      }} /></label>
      <button className="btn" aria-label="翌月の売上" onClick={() => shift(1)}>翌月</button>
      <button className="btn" onClick={() => { setMonth(japanMonth()); setSelected(null); }}>今月</button>
    </div>
    {loading ? <p role="status">売上を読み込み中…</p> : error ? <div className="error" role="alert">{error}</div> : <>
      <div className="sales-summary"><strong>{month} の売上 {yen(total)}</strong><span>{days.reduce((n, d) => n + d.count, 0)}商品</span></div>
      {conflicts.length > 0 && <div className="error">同じ通番号で販売記録が異なる{conflicts.length}商品は集計に含めていません。元の記録は保持しています。<details><summary>確認が必要な通番号</summary>{conflicts.join('、')}</details></div>}
      <div className="sales-chart-scroll">
        <svg viewBox="0 0 980 305" className="sales-chart" role="group" aria-label={`${month}の日別売上の折れ線グラフ。各日を選択すると金額を表示します。`}>
          {[0, 1, 2, 3, 4].map(t => <g key={t}><line x1={80} x2={940} y1={260 - t * 55} y2={260 - t * 55} className="chart-grid" /><text x={70} y={265 - t * 55} textAnchor="end">{yen(ceiling * t / 4)}</text></g>)}
          <polyline points={days.map((_, i) => { const p = point(i); return `${p.x},${p.y}`; }).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={3} />
          {days.map((d, i) => { const p = point(i); return <g key={d.date}>
            {(i % 5 === 0 || i === days.length - 1) && <text x={p.x} y={290} textAnchor="middle">{i + 1}日</text>}
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
