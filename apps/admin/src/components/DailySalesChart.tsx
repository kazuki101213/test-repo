import { useEffect, useMemo, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchDashboardDailySales, type DashboardScope, type DailySalesSummary } from '../api';
import { dailySalesRange } from '../sales';
import DateInput from './DateInput';

function DailySalesSeries({ label, summary, ceiling, period }: { label: string; summary: DailySalesSummary; ceiling: number; period: string }) {
  const { days, conflicts } = summary;
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected === null ? null : days[selected];
  const total = days.reduce((sum, day) => sum + day.amount, 0);
  const count = days.reduce((sum, day) => sum + day.count, 0);
  const point = (i: number) => ({
    x: days.length === 1 ? 202 : 95 + i * 215 / Math.max(1, days.length - 1),
    y: 167 - (days[i]?.amount ?? 0) / ceiling * 132,
  });
  const dateIndices = new Set([0, Math.round((days.length - 1) / 2), days.length - 1]);

  return <div className="dashboard-comparison-panel">
    <h4>{label}</h4>
    <div className="sales-summary"><strong>{yen(total)}</strong><span>{count}商品</span></div>
    {conflicts.length > 0 && <details className="error">
      <summary>販売記録の不一致 {conflicts.length}件（集計対象外）</summary>{conflicts.join('、')}
    </details>}
    <svg viewBox="0 0 336 205" className="sales-chart" role="group"
      aria-label={`${label} ${period}の日別売上。各日を選択すると金額を表示します。`}>
      {[0, 1, 2].map(t => <g key={t}>
        <line x1={95} x2={310} y1={167 - t * 66} y2={167 - t * 66} className="chart-grid" />
        <text x={90} y={172 - t * 66} textAnchor="end">{yen(ceiling * t / 2)}</text>
      </g>)}
      <polyline points={days.map((_, i) => { const p = point(i); return `${p.x},${p.y}`; }).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={3} />
      {days.map((day, i) => {
        const p = point(i);
        return <g key={day.date}>
          {dateIndices.has(i) && <text x={p.x} y={194} textAnchor="middle">{Number(day.date.slice(5, 7))}/{Number(day.date.slice(8, 10))}</text>}
          <circle cx={p.x} cy={p.y} r={selected === i ? 7 : 4} fill="var(--accent)" />
          <circle cx={p.x} cy={p.y} r={14} className="chart-hit" tabIndex={0} role="button"
            aria-label={`${day.date} 売上 ${yen(day.amount)} ${day.count}商品`}
            onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => setSelected(i)} onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(i); }
            }}><title>{day.date}：{yen(day.amount)}（{day.count}商品）</title></circle>
        </g>;
      })}
    </svg>
    <p className="sales-day" aria-live="polite">{active ? `${active.date}：${yen(active.amount)}（${active.count}商品）` : ''}</p>
  </div>;
}

export default function DailySalesChart({ purchaserName }: { purchaserName: string }) {
  const [today, setToday] = useState(() => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
  const [snapshot, setSnapshot] = useState<{ key: string; value: Record<DashboardScope, DailySalesSummary> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range?.from ?? new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
  const to = range?.to ?? today;
  useEffect(() => {
    const refreshDate = () => setToday(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
    const timer = window.setInterval(refreshDate, 60000);
    return () => window.clearInterval(timer);
  }, []);
  const key = from + ':' + to;
  const rangeError = useMemo(() => {
    try { dailySalesRange([], from, to); return ''; }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }, [from, to]);
  useEffect(() => {
    if (rangeError) return;
    let active = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void fetchDashboardDailySales(from, to)
        .then(value => { if (active) setSnapshot({ key, value }); })
        .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [from, to, key, rangeError]);
  const summary = snapshot?.key === key ? snapshot.value : null;
  const peak = summary ? [summary.all, summary.mine].reduce(
    (max, series) => series.days.reduce((dailyMax, day) => Math.max(dailyMax, day.amount), max), 1,
  ) : 1;
  const ceiling = Math.ceil(peak / 4000) * 4000;
  const period = `${from} 〜 ${to}`;

  return <section className="card daily-sales" aria-label="日別売上">
    <div className="toolbar">
      <h3>{range ? '日別売上' : '日別売上（直近7日間）'}</h3>
    </div>
    <div className="toolbar daily-sales-range">
      <label className="field"><span>開始日</span><DateInput value={from} max={to || undefined} onChange={e => setRange({ from: e.target.value, to })} /></label>
      <label className="field"><span>終了日</span><DateInput value={to} min={from || undefined} onChange={e => setRange({ from, to: e.target.value })} /></label>
      <button className="btn" onClick={() => setRange(null)}>直近7日間</button>
    </div>
    {error || rangeError ? <div className="error" role="alert">{rangeError || error}</div> :
      (loading || !summary) ? <p role="status">売上を読み込み中…</p> : <>
        <p className="sub">{period}</p>
        <div className="dashboard-comparison" key={key}>
          <DailySalesSeries label="全体" summary={summary.all} ceiling={ceiling} period={period} />
          <DailySalesSeries label={purchaserName} summary={summary.mine} ceiling={ceiling} period={period} />
        </div>
      </>}
  </section>;
}
