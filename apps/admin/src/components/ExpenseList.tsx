import { useEffect, useRef, useState } from 'react';
import { yen } from '@bussan/shared';
import { deleteExpenses, fetchExpenses, fetchExpenseDrafts, updateExpenseField, type ExpenseField } from '../api';
import type { ExpenseInput, ExpenseDraft } from '../expenses';
import { expenseCategories, expenseCategoryLabel } from '../expenses';
import ExpensePanel from './ExpensePanel';
import AskulExpenseImport from './AskulExpenseImport';
import './ExpenseSelection.css';

type ExpenseCategory = typeof expenseCategories[number];
const compactExpenseLayout = 'screen and (max-width: 1023px)';
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
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [compact, setCompact] = useState(() => window.matchMedia(compactExpenseLayout).matches);
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | ''>('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deletion, setDeletion] = useState<{ rows: ExpenseInput[]; requestId: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [message, setMessage] = useState('');
  const [askulImportOpen, setAskulImportOpen] = useState(false);
  const [askulResult, setAskulResult] = useState<{ inserted: number; skipped: number } | null>(null);
  useEffect(() => {
    const screen = window.matchMedia(compactExpenseLayout);
    const update = (event: MediaQueryListEvent) => {
      setCompact(event.matches);
      setSelected(new Set());
    };
    screen.addEventListener('change', update);
    return () => screen.removeEventListener('change', update);
  }, []);
  const deleteLock = useRef(false);
  async function removeSelected() {
    if (!deletion || deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setDeleteError('');
    try {
      const count = await deleteExpenses(deletion.rows, deletion.requestId);
      const ids = new Set(deletion.rows.map(row => row.id));
      setRows(current => current.filter(row => !ids.has(row.id)));
      setDrafts(current => current.filter(row => !ids.has(row.id)));
      setSelected(new Set()); setDeletion(null); setMessage(`${count}件の経費を削除しました。`);
      setSavedRevision(value => value + 1);
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : String(cause)); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  const [fieldEdit, setFieldEdit] = useState<{ row: ExpenseInput; field: ExpenseField; value: string } | null>(null);
  async function saveField() {
    if (!fieldEdit) return;
    setExpenseBusy(true); setError('');
    try { await updateExpenseField(fieldEdit.row, fieldEdit.field, fieldEdit.value); setFieldEdit(null); setSavedRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExpenseBusy(false); }
  }
  const editCell = (row: ExpenseInput, field: ExpenseField, label: string) => <button type="button" className="expense-edit" disabled={expenseBusy || !!deletion} onClick={() => { setFieldEdit({ row, field, value: field === 'category' ? displayCategory(row) : String(row[field]) }); setError(''); }}>{label}</button>;
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([fetchExpenses(), fetchExpenseDrafts()]).then(([data, pending]) => { if (active) { setRows(data); setDrafts(pending); setSelected(new Set()); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, savedRevision]);
  const visibleCategories = compact && categoryFilter ? [categoryFilter] : expenseCategories;
  const search = query.trim().toLowerCase();
  const matchesSearch = (name: string) => name.toLowerCase().includes(search);
  const filtered = rows.filter(row => visibleCategories.includes(displayCategory(row)) && matchesSearch(row.name));
  const pending = drafts.filter(d => !rows.some(row => row.id === d.id || (expenseCategoryLabel(row.category) === d.category && row.incurred_on.slice(0, 7) === d.target_month.slice(0, 7) && row.name === d.name))
    && matchesSearch(d.name));
  return <div className="dashboard-workspace with-expense registration-workspace">
    <section id="expense-list" className="card expense-list dashboard-content" aria-label="経費">
    <div className="toolbar expense-search-toolbar">
      <button type="button" className="btn" disabled={expenseBusy || !!deletion} onClick={() => { setAskulResult(null); setAskulImportOpen(true); }}>アスクルCSV取り込み</button>
      {compact && <select aria-label="経費区分で絞り込む" value={categoryFilter} disabled={!!deletion} onChange={e => {
        setCategoryFilter(e.currentTarget.value as ExpenseCategory | '');
        setSelected(new Set());
      }}>
        <option value="">すべて</option>
        {expenseCategories.map(category => <option key={category} value={category}>{category}</option>)}
      </select>}
      <input aria-label="経費を検索" placeholder="検索" type="search" value={query} disabled={!!deletion} onChange={e => { setQuery(e.target.value); setSelected(new Set()); }} />
      <button type="button" className="btn" disabled={loading || expenseBusy || !!deletion || !selected.size} onClick={() => { setDeleteError(''); setMessage(''); setDeletion({ rows: filtered.filter(row => selected.has(row.id)).map(row => ({...row})), requestId: crypto.randomUUID() }); }}>削除</button>
    </div>
    {message && <p className="ok" role="status">{message}</p>}
    {askulResult && <p className="ok" role="status" data-askul-inserted={askulResult.inserted} data-askul-skipped={askulResult.skipped}>アスクルCSVから{askulResult.inserted}件を登録しました。登録済み{askulResult.skipped}件。</p>}
    {error ? <div className="error">{error}</div> : loading ? <p>読み込み中…</p> : <>
      <div className="expense-columns-scroll"><div className="expense-columns">{visibleCategories.map(category => {
        const entries = filtered.filter(row => displayCategory(row) === category);
        const categoryDrafts = pending.filter(row => row.category === category);
        const months = [...new Set([...entries.map(row => row.incurred_on.slice(0, 7)), ...categoryDrafts.map(row => row.target_month.slice(0, 7))])].sort().reverse();
        return <section className="expense-column" key={category} aria-label={category}>
          <header><h3>{category}</h3><p>{entries.length}件 · <strong>{yen(entries.reduce((sum, row) => sum + row.amount, 0))}</strong></p></header>
          {months.length === 0 ? <p className="sub">該当する経費はありません。</p> : <ul className="expense-entries">{months.map(month => <li key={month} className="expense-month-group"><h4>{month.replace('-', '年')}月 · {yen(entries.filter(row => row.incurred_on.startsWith(month)).reduce((sum, row) => sum + row.amount, 0))}</h4><ul className="expense-entries">{entries.filter(row => row.incurred_on.startsWith(month)).map(row => <li key={row.id}>
            <div className="expense-entry-top"><time dateTime={row.incurred_on}>{editCell(row, 'incurred_on', row.incurred_on)}</time><label className="expense-selection"><input type="checkbox" aria-label={`${row.incurred_on} ${row.name}を選択`} checked={selected.has(row.id)} disabled={loading || expenseBusy || !!deletion} onChange={e => { const checked=e.target.checked; setSelected(current => { const next=new Set(current); checked ? next.add(row.id) : next.delete(row.id); return next; }); }} /></label></div>
            <div>{editCell(row, 'name', row.name)}</div>
            <div className="expense-entry-bottom"><span className="expense-hint">{editCell(row, 'category', expenseCategoryLabel(row.category))}</span><strong>{editCell(row, 'amount', yen(row.amount))}</strong></div>
          </li>)}{categoryDrafts.filter(row => row.target_month.startsWith(month)).map(row => <li key={row.id}>
            <button className="expense-edit" disabled={expenseBusy} aria-label={`${row.name}の金額と日付を入力`} onClick={() => { setEditing(undefined); setDraft(row); }}>
              <div>{row.name}</div><span className="expense-hint">日付・金額の入力待ち</span>
            </button>
          </li>)}</ul></li>)}</ul>}
        </section>;
      })}</div></div>
    </>}
  </section>
  {<ExpensePanel key={editing?.id ?? draft?.id ?? 'new'} initial={editing} template={draft ? { ...draft, month: draft.target_month.slice(0, 7) } : undefined} onSaved={() => setSavedRevision(value => value + 1)} onBusyChange={setExpenseBusy} onClose={draft ? () => { if (expenseBusy) return; setEditing(undefined); setDraft(undefined); } : undefined} />}
  {fieldEdit && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="経費の項目を編集"><div className="card inventory-comment-panel">
    <h3>{{ incurred_on: '日付', category: '区分', name: '内容', amount: '金額' }[fieldEdit.field]}を編集</h3>
    <label className="field"><span>{fieldEdit.row.name}</span>{fieldEdit.field === 'category' ? <select value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })}>{(['固定費', '変動費', '外注費'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select>
      : <input autoFocus type={fieldEdit.field === 'incurred_on' ? 'date' : fieldEdit.field === 'amount' ? 'number' : 'text'} value={fieldEdit.value} onChange={e => setFieldEdit(current => current && { ...current, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveField(); }} />}</label>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="toolbar"><button className="btn primary" disabled={expenseBusy} onClick={() => void saveField()}>保存</button><button className="btn" disabled={expenseBusy} onClick={() => setFieldEdit(null)}>閉じる</button></div>
  </div></div>}
  {askulImportOpen && <AskulExpenseImport onClose={() => setAskulImportOpen(false)} onSaved={({ inserted, skipped }) => {
    setAskulImportOpen(false);
    setQuery('');
    setCategoryFilter('');
    setAskulResult({ inserted, skipped });
    setSavedRevision(value => value + 1);
  }} />}
  {deletion && <ExpenseDeleteConfirmation rows={deletion.rows} busy={deleting} error={deleteError} onDelete={() => void removeSelected()} onClose={() => { if (!deleteLock.current) setDeletion(null); }} />}
  </div>;
}

function ExpenseDeleteConfirmation({ rows, busy, error, onDelete, onClose }: { rows: ExpenseInput[]; busy: boolean; error: string; onDelete: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element=dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="expense-delete-confirmation" aria-label="経費の削除" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h3>経費の削除</h3><p>選択した{rows.length}件の経費を削除しますか？</p>
    <ul>{rows.map(row => <li key={row.id}>{row.incurred_on}　{row.name}　{yen(row.amount)}</li>)}</ul>
    <p>合計 {yen(rows.reduce((total,row) => total+row.amount,0))}</p>
    {rows.some(row => row.memo?.startsWith('納品請求書 ')) && <p>請求書の承認記録は変更されません。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="toolbar"><button type="button" className="btn primary" disabled={busy} onClick={onDelete}>{busy ? '削除中…' : '削除'}</button><button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>閉じる</button></div>
  </dialog>;
}
