import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchExpenses, fetchExpenseDrafts } from '../api';
import type { ExpenseInput, ExpenseDraft } from '../expenses';
import ExpensePanel from './ExpensePanel';
import { japanMonth } from '../sales';

const columns = ['固定費', '変動費', '給与'] as const;
const displayCategory = (row: ExpenseInput) => row.category === '固定費' || row.category === '給与' ? row.category : '変動費';

export function ExpenseTable({ rows }: { rows: ExpenseInput[] }) {
  return rows.length === 0 ? <p className="sub">該当する経費はありません。</p> : <div className="scroll expense-table"><table>
    <thead><tr><th>日付</th><th>区分</th><th>内容</th><th className="num">金額</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{row.incurred_on}</td><td>{row.category}</td><td className="detail-description">{row.name}</td><td className="num">{yen(row.amount)}</td></tr>)}</tbody>
  </table></div>;
}

export default function ExpenseList({ revision }: { revision: number }) {
  const [rows, setRows] = useState<ExpenseInput[]>([]);
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [editing, setEditing] = useState<ExpenseInput | undefined>();
  const [draft, setDraft] = useState<ExpenseDraft | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(japanMonth);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([fetchExpenses(), fetchExpenseDrafts()]).then(([data, pending]) => { if (active) { setRows(data); setDrafts(pending); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, savedRevision]);
  const filtered = rows.filter(row => row.incurred_on.slice(0, 7) === month
    && (!query.trim() || row.name.toLowerCase().includes(query.trim().toLowerCase())));
  const pending = drafts.filter(d => d.target_month.slice(0, 7) === month
    && !rows.some(row => row.id === d.id || (row.category === '固定費' && row.incurred_on.slice(0, 7) === month && row.name === d.name))
    && (!query.trim() || d.name.toLowerCase().includes(query.trim().toLowerCase())));
  return <div className={`dashboard-workspace${expenseOpen ? ' with-expense' : ''}`}>
    <section id="expense-list" className="card expense-list dashboard-content" aria-label="経費一覧">
    <div className="toolbar"><h2>経費一覧</h2><span style={{ flex: 1 }} />
      <button className="btn" aria-expanded={expenseOpen} aria-controls="expense-panel" disabled={expenseBusy} onClick={() => { setExpenseOpen(open => !open); setEditing(undefined); setDraft(undefined); }}>{expenseOpen ? '経費入力を閉じる' : '経費を入力'}</button>
    </div>
    <div className="toolbar">
      <label className="field"><span>表示月</span><input type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} /></label>
      <label className="field"><span>内容</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    </div>
    {error ? <div className="error">{error}</div> : loading ? <p>読み込み中…</p> : <>
      <div className="expense-columns-scroll"><div className="expense-columns">{columns.map(category => {
        const entries = filtered.filter(row => displayCategory(row) === category);
        return <section className="expense-column" key={category} aria-label={category}>
          <header><h3>{category}</h3><p>{entries.length}件 · <strong>{yen(entries.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {entries.length === 0 && (category !== '固定費' || pending.length === 0) ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{entries.map(row => <li key={row.id}>
            <button className="expense-edit" disabled={expenseBusy} aria-label={`${row.incurred_on} ${row.name}を編集`} onClick={() => { setEditing(row); setDraft(undefined); setExpenseOpen(true); }}>
            <div className="expense-entry-top"><time dateTime={row.incurred_on}>{row.incurred_on}</time><strong>{yen(row.amount)}</strong></div>
            <div>{row.name}</div>
            {row.category !== category && <span className="expense-hint">{row.category}</span>}
            </button>
          </li>)}{category === '固定費' && pending.map(row => <li key={row.id}>
            <button className="expense-edit" disabled={expenseBusy} aria-label={`${row.name}の金額と日付を入力`} onClick={() => { setEditing(undefined); setDraft(row); setExpenseOpen(true); }}>
              <div>{row.name}</div><span className="expense-hint">日付・金額の入力待ち</span>
            </button>
          </li>)}</ul>}
        </section>;
      })}</div></div>
    </>}
  </section>
  {expenseOpen && <ExpensePanel key={editing?.id ?? draft?.id ?? 'new'} initial={editing} template={draft ? { ...draft, month: draft.target_month.slice(0, 7) } : undefined} onSaved={saved => { setMonth(saved.incurred_on.slice(0, 7)); setSavedRevision(value => value + 1); }} onBusyChange={setExpenseBusy} />}
  </div>;
}
