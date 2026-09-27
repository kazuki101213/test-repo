import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchExpenses } from '../api';
import type { ExpenseInput } from '../expenses';

const columns = ['固定費', '変動費', '給与'] as const;
const displayCategory = (row: ExpenseInput) => row.category === '固定費' || row.category === '給与' ? row.category : '変動費';

export function ExpenseTable({ rows }: { rows: ExpenseInput[] }) {
  return rows.length === 0 ? <p className="sub">該当する経費はありません。</p> : <div className="scroll expense-table"><table>
    <thead><tr><th>日付</th><th>区分</th><th>内容</th><th className="num">金額</th><th>メモ</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{row.incurred_on}</td><td>{row.category}</td><td className="detail-description">{row.name}</td><td className="num">{yen(row.amount)}</td><td className="detail-description">{row.memo || '—'}</td></tr>)}</tbody>
  </table></div>;
}

export default function ExpenseList({ revision }: { revision: number }) {
  const [rows, setRows] = useState<ExpenseInput[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    fetchExpenses().then(data => { if (active) setRows(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const filtered = rows.filter(row => (!from || row.incurred_on >= from) && (!to || row.incurred_on <= to)
    && (!query.trim() || (row.name + ' ' + (row.memo || '')).toLowerCase().includes(query.trim().toLowerCase())));
  return <section id="expense-list" className="card expense-list" aria-label="経費一覧">
    <h2>経費一覧</h2>
    <div className="toolbar">
      <label className="field"><span>開始日</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label className="field"><span>終了日</span><input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
      <label className="field"><span>内容・メモ</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    </div>
    {error ? <div className="error">{error}</div> : loading ? <p>読み込み中…</p> : <>
      <p>{filtered.length}件・合計 {yen(filtered.reduce((sum, row) => sum + row.amount, 0))}</p>
      <div className="expense-columns-scroll"><div className="expense-columns">{columns.map(category => {
        const entries = filtered.filter(row => displayCategory(row) === category);
        return <section className="expense-column" key={category} aria-label={category}>
          <header><h3>{category}</h3><p>{entries.length}件 · <strong>{yen(entries.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {entries.length === 0 ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{entries.map(row => <li key={row.id}>
            <div className="expense-entry-top"><time dateTime={row.incurred_on}>{row.incurred_on}</time><strong>{yen(row.amount)}</strong></div>
            <div>{row.name}</div>
            {row.category !== category && <span className="expense-hint">{row.category}</span>}
            {row.memo && <p className="expense-hint">{row.memo}</p>}
          </li>)}</ul>}
        </section>;
      })}</div></div>
    </>}
  </section>;
}
