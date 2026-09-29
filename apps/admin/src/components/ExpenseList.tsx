import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import { fetchExpenses, fetchExpenseDrafts, updateExpenseField, type ExpenseField } from '../api';
import type { ExpenseInput, ExpenseDraft } from '../expenses';
import { expenseCategoryLabel } from '../expenses';
import ExpensePanel from './ExpensePanel';

const columns = ['固定費', '変動費', '外注費'] as const;
const displayCategory = (row: ExpenseInput) => row.category === '固定費' ? '固定費' : row.category === '給与' || row.category === '外注費' ? '外注費' : '変動費';

export function ExpenseTable({ rows }: { rows: ExpenseInput[] }) {
  return rows.length === 0 ? <p className="sub">該当する経費はありません。</p> : <div className="scroll expense-table"><table>
    <thead><tr><th>日付</th><th>区分</th><th>内容</th><th className="num">金額</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{row.incurred_on}</td><td>{expenseCategoryLabel(row.category)}</td><td className="detail-description">{row.name}</td><td className="num">{yen(row.amount)}</td></tr>)}</tbody>
  </table></div>;
}

export default function ExpenseList({ revision }: { revision: number }) {
  const [rows, setRows] = useState<ExpenseInput[]>([]);
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [editing, setEditing] = useState<ExpenseInput | undefined>();
  const [draft, setDraft] = useState<ExpenseDraft | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [fieldEdit, setFieldEdit] = useState<{ row: ExpenseInput; field: ExpenseField; value: string } | null>(null);
  async function saveField() {
    if (!fieldEdit) return;
    setExpenseBusy(true); setError('');
    try { await updateExpenseField(fieldEdit.row, fieldEdit.field, fieldEdit.value); setFieldEdit(null); setSavedRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExpenseBusy(false); }
  }
  const editCell = (row: ExpenseInput, field: ExpenseField, label: string) => <button type="button" className="expense-edit" disabled={expenseBusy} onClick={() => { setFieldEdit({ row, field, value: field === 'category' ? displayCategory(row) : String(row[field]) }); setError(''); }}>{label}</button>;
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([fetchExpenses(), fetchExpenseDrafts()]).then(([data, pending]) => { if (active) { setRows(data); setDrafts(pending); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, savedRevision]);
  const filtered = rows.filter(row => !query.trim() || row.name.toLowerCase().includes(query.trim().toLowerCase()));
  const pending = drafts.filter(d => !rows.some(row => row.id === d.id || (expenseCategoryLabel(row.category) === d.category && row.incurred_on.slice(0, 7) === d.target_month.slice(0, 7) && row.name === d.name))
    && (!query.trim() || d.name.toLowerCase().includes(query.trim().toLowerCase())));
  return <div className={`dashboard-workspace${expenseOpen ? ' with-expense' : ''}`}>
    <section id="expense-list" className="card expense-list dashboard-content" aria-label="経費一覧">
    <div className="toolbar"><h2>経費一覧</h2><span style={{ flex: 1 }} />
      <button className="btn" aria-expanded={expenseOpen} aria-controls="expense-panel" disabled={expenseBusy} onClick={() => { setExpenseOpen(open => !open); setEditing(undefined); setDraft(undefined); }}>{expenseOpen ? '経費登録を閉じる' : '経費登録'}</button>
    </div>
    <div className="toolbar">
      <label className="field"><span>内容</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    </div>
    {error ? <div className="error">{error}</div> : loading ? <p>読み込み中…</p> : <>
      <div className="expense-columns-scroll"><div className="expense-columns">{columns.map(category => {
        const entries = filtered.filter(row => displayCategory(row) === category);
        const categoryDrafts = pending.filter(row => row.category === category);
        const months = [...new Set([...entries.map(row => row.incurred_on.slice(0, 7)), ...categoryDrafts.map(row => row.target_month.slice(0, 7))])].sort().reverse();
        return <section className="expense-column" key={category} aria-label={category}>
          <header><h3>{category}</h3><p>{entries.length}件 · <strong>{yen(entries.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {months.length === 0 ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{months.map(month => <li key={month} className="expense-month-group"><h4>{month.replace('-', '年')}月 · {yen(entries.filter(row => row.incurred_on.startsWith(month)).reduce((sum, row) => sum + row.amount, 0))}</h4><ul className="expense-entries">{entries.filter(row => row.incurred_on.startsWith(month)).map(row => <li key={row.id}>
            <div className="expense-entry-top"><time dateTime={row.incurred_on}>{editCell(row, 'incurred_on', row.incurred_on)}</time><strong>{editCell(row, 'amount', yen(row.amount))}</strong></div>
            <div>{editCell(row, 'name', row.name)}</div>
            <span className="expense-hint">{editCell(row, 'category', expenseCategoryLabel(row.category))}</span>
          </li>)}{categoryDrafts.filter(row => row.target_month.startsWith(month)).map(row => <li key={row.id}>
            <button className="expense-edit" disabled={expenseBusy} aria-label={`${row.name}の金額と日付を入力`} onClick={() => { setEditing(undefined); setDraft(row); setExpenseOpen(true); }}>
              <div>{row.name}</div><span className="expense-hint">日付・金額の入力待ち</span>
            </button>
          </li>)}</ul></li>)}</ul>}
        </section>;
      })}</div></div>
    </>}
  </section>
  {expenseOpen && <ExpensePanel key={editing?.id ?? draft?.id ?? 'new'} initial={editing} template={draft ? { ...draft, month: draft.target_month.slice(0, 7) } : undefined} onSaved={() => setSavedRevision(value => value + 1)} onBusyChange={setExpenseBusy} />}
  {fieldEdit && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="経費の項目を編集"><div className="card inventory-comment-panel">
    <h3>{{ incurred_on: '日付', category: '区分', name: '内容', amount: '金額' }[fieldEdit.field]}を編集</h3>
    <label className="field"><span>{fieldEdit.row.name}</span>{fieldEdit.field === 'category' ? <select value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })}>{(['固定費', '変動費', '外注費'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select>
      : <input autoFocus type={fieldEdit.field === 'incurred_on' ? 'date' : fieldEdit.field === 'amount' ? 'number' : 'text'} value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveField(); }} />}</label>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="toolbar"><button className="btn primary" disabled={expenseBusy} onClick={() => void saveField()}>保存</button><button className="btn" disabled={expenseBusy} onClick={() => setFieldEdit(null)}>閉じる</button></div>
  </div></div>}
  </div>;
}
